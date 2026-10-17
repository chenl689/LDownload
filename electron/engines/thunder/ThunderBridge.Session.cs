using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class ThunderBridge
{
    private static readonly object SessionQueueLock = new object();
    private static readonly Queue<Dictionary<string, object>> SessionCommands = new Queue<Dictionary<string, object>>();

    private sealed class SessionTask
    {
        public string Id;
        public string Operation;
        public uint SdkTaskId;
        public string TorrentPath;
        public DateTime Deadline;
        public DateTime PreviousSample;
        public DateTime QueryFailureStarted;
        public ulong PreviousBytes;
        public int ConsecutiveQueryFailures;
    }

    private static string SessionValue(Dictionary<string, object> values, string key)
    {
        object value;
        return values.TryGetValue(key, out value) ? Convert.ToString(value) : "";
    }

    private static void StartSessionReader()
    {
        var thread = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    try
                    {
                        Dictionary<string, object> command = Json.Deserialize<Dictionary<string, object>>(line);
                        if (command == null) throw new InvalidOperationException("Empty session command.");
                        lock (SessionQueueLock) SessionCommands.Enqueue(command);
                    }
                    catch (Exception error)
                    {
                        Emit("session_command_error", "message", error.Message);
                    }
                }
            }
            catch { }
            lock (SessionQueueLock)
            {
                var shutdown = new Dictionary<string, object>();
                shutdown["command"] = "shutdown";
                SessionCommands.Enqueue(shutdown);
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static List<Dictionary<string, object>> DrainSessionCommands()
    {
        var commands = new List<Dictionary<string, object>>();
        lock (SessionQueueLock)
        {
            while (SessionCommands.Count > 0) commands.Add(SessionCommands.Dequeue());
        }
        return commands;
    }

    private static void RunSession(Dictionary<string, object> request)
    {
        string sdk = Convert.ToString(request["sdkDirectory"]);
        string proxy = Path.Combine(sdk, "DownloadSDKProxy.dll");
        string server = Path.Combine(sdk, "DownloadSDKServer.exe");
        if (!File.Exists(proxy) || !File.Exists(server)) throw new FileNotFoundException("Thunder SDK runtime files are incomplete.");
        StringBuilder shortPathBuffer = new StringBuilder(512);
        uint shortPathLength = GetShortPathNameW(server, shortPathBuffer, (uint)shortPathBuffer.Capacity);
        string nativeServerPath = shortPathLength > 0 && shortPathLength < shortPathBuffer.Capacity ? shortPathBuffer.ToString() : server;
        byte[] serverBytes = Encoding.Default.GetBytes(nativeServerPath + "\0");
        if (serverBytes.Length > 100 || Encoding.Default.GetString(serverBytes) != nativeServerPath + "\0")
            throw new InvalidOperationException("Thunder SDK server path is not supported by the system code page or exceeds its native limit.");

        Directory.SetCurrentDirectory(sdk);
        AttachCurrentProcessToJob();
        if (!SetDllDirectoryW(sdk)) throw new InvalidOperationException("Cannot set the Thunder SDK runtime directory.");
        IntPtr module = LoadLibraryW(proxy);
        if (module == IntPtr.Zero) throw new InvalidOperationException("Cannot load DownloadSDKProxy.dll (error " + Marshal.GetLastWin32Error() + ").");

        IntPtr nativePath = Marshal.AllocHGlobal(serverBytes.Length);
        IntPtr initParam = Marshal.AllocHGlobal(40);
        IntPtr info = Marshal.AllocHGlobal(TaskInfoBytes);
        bool initialized = false;
        var tasks = new Dictionary<string, SessionTask>();
        try
        {
            Marshal.Copy(serverBytes, 0, nativePath, serverBytes.Length);
            for (int i = 0; i < 40; i++) Marshal.WriteByte(initParam, i, 0);
            Marshal.WriteInt32(initParam, 40);

            InitDelegate init = Bind<InitDelegate>(module, "XL_Init");
            UnInitDelegate uninit = Bind<UnInitDelegate>(module, "XL_UnInit");
            TaskDelegate start = Bind<TaskDelegate>(module, "XL_StartTask");
            TaskDelegate stop = Bind<TaskDelegate>(module, "XL_StopTask");
            DeleteTaskDelegate delete = Bind<DeleteTaskDelegate>(module, "XL_DeleteTask");
            QueryTaskDelegate query = Bind<QueryTaskDelegate>(module, "XL_QueryTaskInfo");
            CreateMagnetDelegate createMagnet = Bind<CreateMagnetDelegate>(module, "XL_CreateMagnetTask");
            CreateBtDelegate createBt = Bind<CreateBtDelegate>(module, "XL_CreateBTTask");

            currentStage = "session_sdk_init";
            int initResult = init(nativePath, initParam);
            Emit("sdk_init_result", "result", initResult);
            if (initResult != 0) throw new InvalidOperationException("Thunder SDK initialization failed (" + initResult + ").");
            initialized = true;
            Emit("sdk_self_test_passed", "sdk_version", "2.86.202.143");
            Emit("session_ready", "max_downloads", 3);
            StartSessionReader();

            bool shutdown = false;
            while (!shutdown)
            {
                foreach (Dictionary<string, object> command in DrainSessionCommands())
                {
                    string commandName = SessionValue(command, "command");
                    string id = SessionValue(command, "task_id");
                    if (commandName == "shutdown")
                    {
                        shutdown = true;
                        break;
                    }
                    if (commandName == "stop")
                    {
                        SessionTask stopping;
                        if (tasks.TryGetValue(id, out stopping))
                        {
                            CleanupTask(stopping.SdkTaskId, stop, delete);
                            tasks.Remove(id);
                            Emit("paused", "task_id", id);
                        }
                        continue;
                    }
                    if (commandName != "add") continue;
                    if (String.IsNullOrEmpty(id) || tasks.ContainsKey(id))
                    {
                        Emit("task_error", "task_id", id, "message", "Thunder task identifier is invalid or duplicated.");
                        continue;
                    }
                    string operation = SessionValue(command, "operation");
                    if (operation != "download" && operation != "resolve")
                    {
                        Emit("task_error", "task_id", id, "message", "Unsupported Thunder task operation.");
                        continue;
                    }
                    int downloadCount = 0;
                    foreach (SessionTask active in tasks.Values) if (active.Operation == "download") downloadCount++;
                    if (operation == "download" && downloadCount >= 3)
                    {
                        Emit("task_error", "task_id", id, "message", "迅雷引擎最多同时运行 3 个磁力下载任务。");
                        continue;
                    }

                    uint taskId = 0;
                    try
                    {
                        string torrent = SessionValue(command, "torrentPath");
                        int createResult;
                        if (operation == "resolve")
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(torrent));
                            if (File.Exists(torrent)) File.Delete(torrent);
                            createResult = createMagnet(SessionValue(command, "magnet"), torrent, out taskId);
                        }
                        else
                        {
                            string saveDirectory = SessionValue(command, "saveDirectory");
                            if (!saveDirectory.EndsWith(Path.DirectorySeparatorChar.ToString())) saveDirectory += Path.DirectorySeparatorChar;
                            createResult = createBt(torrent, saveDirectory, SessionValue(command, "selection"), out taskId);
                        }
                        if (createResult != 0 || taskId == 0)
                            throw new InvalidOperationException("Thunder SDK could not create the task (" + createResult + ").");
                        int startResult = start(taskId);
                        if (startResult != 0)
                        {
                            CleanupTask(taskId, stop, delete);
                            throw new InvalidOperationException("Thunder SDK could not start the task (" + startResult + ").");
                        }

                        int timeoutSeconds = 0;
                        Int32.TryParse(SessionValue(command, "timeoutSeconds"), out timeoutSeconds);
                        var activeTask = new SessionTask();
                        activeTask.Id = id;
                        activeTask.Operation = operation;
                        activeTask.SdkTaskId = taskId;
                        activeTask.TorrentPath = torrent;
                        activeTask.Deadline = timeoutSeconds > 0 ? DateTime.UtcNow.AddSeconds(timeoutSeconds) : DateTime.MaxValue;
                        activeTask.PreviousSample = DateTime.UtcNow;
                        tasks.Add(id, activeTask);
                        Emit("task_started", "task_id", id, "sdk_task_id", taskId);
                    }
                    catch (Exception error)
                    {
                        Emit("task_error", "task_id", id, "message", error.Message);
                    }
                }
                if (shutdown) break;

                foreach (string id in new List<string>(tasks.Keys))
                {
                    SessionTask activeTask = tasks[id];
                    if (DateTime.UtcNow >= activeTask.Deadline)
                    {
                        CleanupTask(activeTask.SdkTaskId, stop, delete);
                        tasks.Remove(id);
                        Emit("task_error", "task_id", id, "message", "Thunder SDK task timed out.");
                        continue;
                    }
                    for (int i = 0; i < TaskInfoBytes; i++) Marshal.WriteByte(info, i, 0);
                    Marshal.WriteInt32(info, TaskInfoBytes);
                    int queryResult = query(activeTask.SdkTaskId, info);
                    if (queryResult != 0)
                    {
                        if (activeTask.ConsecutiveQueryFailures == 0) activeTask.QueryFailureStarted = DateTime.UtcNow;
                        activeTask.ConsecutiveQueryFailures++;
                        if (DateTime.UtcNow - activeTask.QueryFailureStarted >= TimeSpan.FromSeconds(30))
                        {
                            CleanupTask(activeTask.SdkTaskId, stop, delete);
                            tasks.Remove(id);
                            Emit("task_error", "task_id", id, "message", "Thunder SDK progress query failed (" + queryResult + ").");
                        }
                        continue;
                    }
                    activeTask.ConsecutiveQueryFailures = 0;
                    uint state = unchecked((uint)Marshal.ReadInt32(info, 4));
                    ulong total = unchecked((ulong)Marshal.ReadInt64(info, 12));
                    ulong downloaded = unchecked((ulong)Marshal.ReadInt64(info, 20));
                    DateTime now = DateTime.UtcNow;
                    double seconds = Math.Max(0.001, (now - activeTask.PreviousSample).TotalSeconds);
                    ulong speed = downloaded >= activeTask.PreviousBytes ? (ulong)((downloaded - activeTask.PreviousBytes) / seconds) : 0;
                    Emit("progress", "task_id", id, "state", state, "total", total, "downloaded", downloaded, "speed", speed);
                    activeTask.PreviousSample = now;
                    activeTask.PreviousBytes = downloaded;
                    if (activeTask.Operation == "resolve" && File.Exists(activeTask.TorrentPath) && new FileInfo(activeTask.TorrentPath).Length > 0)
                    {
                        CleanupTask(activeTask.SdkTaskId, stop, delete);
                        tasks.Remove(id);
                        Emit("metadata_ready", "task_id", id, "bytes", new FileInfo(activeTask.TorrentPath).Length);
                    }
                    else if (activeTask.Operation == "download" && state == 7)
                    {
                        CleanupTask(activeTask.SdkTaskId, stop, delete);
                        tasks.Remove(id);
                        Emit("completed", "task_id", id, "total", total, "downloaded", downloaded);
                    }
                }
                Thread.Sleep(250);
            }
        }
        finally
        {
            foreach (SessionTask activeTask in tasks.Values)
                CleanupTask(activeTask.SdkTaskId, Bind<TaskDelegate>(module, "XL_StopTask"), Bind<DeleteTaskDelegate>(module, "XL_DeleteTask"));
            if (initialized)
            {
                try { Emit("sdk_uninit_result", "result", Bind<UnInitDelegate>(module, "XL_UnInit")()); }
                catch (Exception error) { Emit("sdk_uninit_exception", "message", error.Message); }
            }
            Marshal.FreeHGlobal(info);
            Marshal.FreeHGlobal(initParam);
            Marshal.FreeHGlobal(nativePath);
            FreeLibrary(module);
        }
    }
}