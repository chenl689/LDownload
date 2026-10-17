using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class ThunderBridge
{
    private const int TaskInfoBytes = 924;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static int cancelled;
    private static IntPtr job;
    private static string currentStage = "read_request";

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int InitDelegate(IntPtr serverPath, IntPtr initParam);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int UnInitDelegate();
    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode)]
    private delegate int CreateMagnetDelegate(string magnet, string torrentPath, out uint taskId);
    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode)]
    private delegate int CreateBtDelegate(string torrentPath, string saveDirectory,
        [MarshalAs(UnmanagedType.LPStr)] string selection, out uint taskId);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int TaskDelegate(uint taskId);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int DeleteTaskDelegate(uint taskId, int deleteData);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int QueryTaskDelegate(uint taskId, IntPtr buffer);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDllDirectoryW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
        EntryPoint = "GetShortPathNameW")]
    private static extern uint GetShortPathNameW(string longPath, StringBuilder shortPath,
        uint bufferLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass,
        IntPtr info, uint infoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void Emit(string eventName, params object[] fields)
    {
        var output = new Dictionary<string, object>();
        output["event"] = eventName;
        for (int i = 0; i + 1 < fields.Length; i += 2)
            output[Convert.ToString(fields[i])] = fields[i + 1];
        Console.Out.WriteLine(Json.Serialize(output));
        Console.Out.Flush();
    }

    private static T Bind<T>(IntPtr module, string name) where T : class
    {
        IntPtr address = GetProcAddress(module, name);
        if (address == IntPtr.Zero)
            throw new InvalidOperationException("The bundled Thunder SDK is missing " + name + ".");
        return Marshal.GetDelegateForFunctionPointer(address, typeof(T)) as T;
    }

    private static void StartControlReader()
    {
        var thread = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.IndexOf("stop", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        Interlocked.Exchange(ref cancelled, 1);
                        return;
                    }
                }
                Interlocked.Exchange(ref cancelled, 1);
            }
            catch { Interlocked.Exchange(ref cancelled, 1); }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static void AttachCurrentProcessToJob()
    {
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return;
        var limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
        IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimitInformation)));
        try
        {
            Marshal.StructureToPtr(limits, memory, false);
            if (SetInformationJobObject(job, 9, memory,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                AssignProcessToJobObject(job, GetCurrentProcess());
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    private static void Run(Dictionary<string, object> request)
    {
        string sdk = Convert.ToString(request["sdkDirectory"]);
        string workspace = Convert.ToString(request["workspace"]);
        string operation = Convert.ToString(request["operation"]);
        currentStage = "validate_runtime";
        Emit("request_received", "operation", operation,
            "sdk_directory", Path.GetFullPath(sdk),
            "workspace", Path.GetFullPath(workspace),
            "current_directory_before", Environment.CurrentDirectory);
        string proxy = Path.Combine(sdk, "DownloadSDKProxy.dll");
        string server = Path.Combine(sdk, "DownloadSDKServer.exe");
        if (!File.Exists(proxy) || !File.Exists(server))
            throw new FileNotFoundException("Thunder SDK runtime files are incomplete.");
        currentStage = "prepare_server_path";
        StringBuilder shortPathBuffer = new StringBuilder(512);
        uint shortPathLength = GetShortPathNameW(server, shortPathBuffer,
            (uint)shortPathBuffer.Capacity);
        string nativeServerPath = shortPathLength > 0 && shortPathLength < shortPathBuffer.Capacity
            ? shortPathBuffer.ToString()
            : server;
        byte[] serverBytes = Encoding.Default.GetBytes(nativeServerPath + "\0");
        if (serverBytes.Length > 100)
            throw new InvalidOperationException("Thunder SDK path exceeds its 100-byte native limit.");
        if (Encoding.Default.GetString(serverBytes) != nativeServerPath + "\0")
            throw new InvalidOperationException(
                "Thunder SDK path contains characters unsupported by the system code page.");

        // The SDK loads helper assets relative to its working directory. Keep
        // this aligned with the diagnostic probe, which runs from the SDK dir.
        currentStage = "configure_runtime_directories";
        Directory.SetCurrentDirectory(sdk);
        AttachCurrentProcessToJob();
        if (!SetDllDirectoryW(sdk))
            throw new InvalidOperationException("Cannot set the Thunder SDK runtime directory.");
        Emit("runtime_directories_ready",
            "current_directory", Environment.CurrentDirectory,
            "dll_directory", sdk,
            "server_path", nativeServerPath,
            "server_path_bytes", serverBytes.Length);
        currentStage = "load_proxy";
        IntPtr module = LoadLibraryW(proxy);
        if (module == IntPtr.Zero)
            throw new InvalidOperationException("Cannot load DownloadSDKProxy.dll (error " + Marshal.GetLastWin32Error() + ").");
        Emit("proxy_loaded", "path", proxy);

        uint taskId = 0;
        bool initialized = false;
        currentStage = "bind_sdk_exports";
        InitDelegate init = Bind<InitDelegate>(module, "XL_Init");
        UnInitDelegate uninit = Bind<UnInitDelegate>(module, "XL_UnInit");
        TaskDelegate start = Bind<TaskDelegate>(module, "XL_StartTask");
        TaskDelegate stop = Bind<TaskDelegate>(module, "XL_StopTask");
        DeleteTaskDelegate delete = Bind<DeleteTaskDelegate>(module, "XL_DeleteTask");
        QueryTaskDelegate query = Bind<QueryTaskDelegate>(module, "XL_QueryTaskInfo");
        Emit("sdk_exports_bound");
        IntPtr nativePath = Marshal.AllocHGlobal(serverBytes.Length);
        IntPtr initParam = Marshal.AllocHGlobal(40);
        IntPtr info = Marshal.AllocHGlobal(TaskInfoBytes);
        try
        {
            Marshal.Copy(serverBytes, 0, nativePath, serverBytes.Length);
            for (int i = 0; i < 40; i++) Marshal.WriteByte(initParam, i, 0);
            Marshal.WriteInt32(initParam, 40);
            currentStage = "sdk_init";
            Emit("sdk_init_started", "server_path", nativeServerPath,
                "init_parameter_bytes", 40);
            int initResult = init(nativePath, initParam);
            Emit("sdk_init_result", "result", initResult);
            if (initResult != 0)
                throw new InvalidOperationException("Thunder SDK initialization failed (" + initResult + ").");
            initialized = true;
            StartControlReader();

            if (operation == "selftest")
            {
                currentStage = "sdk_self_test_complete";
                Emit("sdk_self_test_passed", "sdk_version", "2.86.202.143");
                return;
            }

            int createResult;
            if (operation == "resolve")
            {
                currentStage = "create_magnet_task";
                CreateMagnetDelegate createMagnet = Bind<CreateMagnetDelegate>(module, "XL_CreateMagnetTask");
                string magnet = Convert.ToString(request["magnet"]);
                string torrent = Convert.ToString(request["torrentPath"]);
                Directory.CreateDirectory(Path.GetDirectoryName(torrent));
                if (File.Exists(torrent)) File.Delete(torrent);
                Emit("task_create_started", "operation", operation,
                    "torrent_path", torrent,
                    "magnet_character_count", magnet.Length);
                createResult = createMagnet(magnet, torrent, out taskId);
            }
            else if (operation == "download")
            {
                currentStage = "create_bt_task";
                CreateBtDelegate createBt = Bind<CreateBtDelegate>(module, "XL_CreateBTTask");
                string torrent = Convert.ToString(request["torrentPath"]);
                string saveDirectory = Convert.ToString(request["saveDirectory"]);
                if (!saveDirectory.EndsWith(Path.DirectorySeparatorChar.ToString()))
                    saveDirectory += Path.DirectorySeparatorChar;
                string selection = Convert.ToString(request["selection"]);
                Emit("task_create_started", "operation", operation,
                    "torrent_path", torrent,
                    "save_directory", saveDirectory,
                    "selection_mask", selection);
                createResult = createBt(torrent, saveDirectory, selection, out taskId);
            }
            else throw new InvalidOperationException("Unsupported Thunder operation.");

            Emit("task_create_result", "operation", operation,
                "result", createResult, "task_id", taskId);
            if (createResult != 0 || taskId == 0)
                throw new InvalidOperationException("Thunder SDK could not create the task (" + createResult + ").");
            currentStage = "start_task";
            int startResult = start(taskId);
            Emit("task_start_result", "result", startResult, "task_id", taskId);
            if (startResult != 0)
                throw new InvalidOperationException("Thunder SDK could not start the task (" + startResult + ").");

            currentStage = "poll_task";
            int timeoutSeconds = Convert.ToInt32(request["timeoutSeconds"]);
            DateTime deadline = timeoutSeconds > 0 ? DateTime.UtcNow.AddSeconds(timeoutSeconds) : DateTime.MaxValue;
            DateTime previousSample = DateTime.UtcNow;
            DateTime queryFailureStarted = DateTime.MinValue;
            int consecutiveQueryFailures = 0;
            ulong previousBytes = 0;
            while (true)
            {
                if (Volatile.Read(ref cancelled) != 0)
                {
                    CleanupTask(taskId, stop, delete);
                    taskId = 0;
                    Emit("paused");
                    return;
                }
                if (DateTime.UtcNow >= deadline)
                    throw new TimeoutException("Thunder SDK task timed out.");

                for (int i = 0; i < TaskInfoBytes; i++) Marshal.WriteByte(info, i, 0);
                Marshal.WriteInt32(info, TaskInfoBytes);
                int queryResult = query(taskId, info);
                if (queryResult != 0)
                {
                    if (consecutiveQueryFailures == 0)
                        queryFailureStarted = DateTime.UtcNow;
                    consecutiveQueryFailures++;
                    TimeSpan queryFailureDuration = DateTime.UtcNow - queryFailureStarted;
                    if (consecutiveQueryFailures == 1 || consecutiveQueryFailures % 10 == 0)
                        Emit("task_query_retry", "operation", operation,
                            "task_id", taskId,
                            "result", queryResult,
                            "retry_count", consecutiveQueryFailures,
                            "elapsed_ms", (long)queryFailureDuration.TotalMilliseconds);
                    if (queryFailureDuration >= TimeSpan.FromSeconds(30))
                        throw new InvalidOperationException("Thunder SDK progress query failed (" +
                            queryResult + ") for " + (long)queryFailureDuration.TotalMilliseconds +
                            " ms after " + consecutiveQueryFailures + " attempts.");
                    Thread.Sleep(500);
                    continue;
                }
                if (consecutiveQueryFailures > 0)
                {
                    Emit("task_query_recovered", "operation", operation,
                        "task_id", taskId,
                        "retry_count", consecutiveQueryFailures,
                        "elapsed_ms", (long)(DateTime.UtcNow - queryFailureStarted).TotalMilliseconds);
                    consecutiveQueryFailures = 0;
                    queryFailureStarted = DateTime.MinValue;
                }
                uint state = unchecked((uint)Marshal.ReadInt32(info, 4));
                ulong total = unchecked((ulong)Marshal.ReadInt64(info, 12));
                ulong downloaded = unchecked((ulong)Marshal.ReadInt64(info, 20));
                DateTime now = DateTime.UtcNow;
                double seconds = Math.Max(0.001, (now - previousSample).TotalSeconds);
                ulong speed = downloaded >= previousBytes ? (ulong)((downloaded - previousBytes) / seconds) : 0;
                Emit("progress", "state", state, "total", total, "downloaded", downloaded, "speed", speed);
                previousSample = now;
                previousBytes = downloaded;

                if (operation == "resolve")
                {
                    string torrent = Convert.ToString(request["torrentPath"]);
                    if (File.Exists(torrent) && new FileInfo(torrent).Length > 0)
                    {
                        Emit("metadata_ready", "bytes", new FileInfo(torrent).Length);
                        CleanupTask(taskId, stop, delete);
                        taskId = 0;
                        return;
                    }
                }
                else if (state == 7)
                {
                    Emit("completed", "total", total, "downloaded", downloaded);
                    CleanupTask(taskId, stop, delete);
                    taskId = 0;
                    return;
                }
                Thread.Sleep(500);
            }
        }
        finally
        {
            if (taskId != 0)
            {
                CleanupTask(taskId, stop, delete);
            }
            if (initialized)
            {
                try { Emit("sdk_uninit_result", "result", uninit()); }
                catch (Exception error)
                {
                    Emit("sdk_uninit_exception", "message", error.Message);
                }
            }
            Marshal.FreeHGlobal(info);
            Marshal.FreeHGlobal(initParam);
            Marshal.FreeHGlobal(nativePath);
            FreeLibrary(module);
        }
    }

    private static void CleanupTask(uint taskId, TaskDelegate stop, DeleteTaskDelegate delete)
    {
        try { Emit("task_stop_result", "task_id", taskId, "result", stop(taskId)); }
        catch (Exception error) { Emit("task_stop_exception", "task_id", taskId, "message", error.Message); }
        try { Emit("task_delete_result", "task_id", taskId, "result", delete(taskId, 0)); }
        catch (Exception error) { Emit("task_delete_exception", "task_id", taskId, "message", error.Message); }
    }

    private static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            string line = Console.In.ReadLine();
            if (String.IsNullOrWhiteSpace(line)) throw new InvalidOperationException("Missing bridge request.");
            Dictionary<string, object> request = Json.Deserialize<Dictionary<string, object>>(line);
            if (Convert.ToString(request["operation"]) == "session") RunSession(request);
            else Run(request);
            return 0;
        }
        catch (Exception error)
        {
            Emit("error", "stage", currentStage,
                "exception_type", error.GetType().FullName,
                "message", error.Message,
                "stack_trace", error.StackTrace);
            return 2;
        }
    }
}
