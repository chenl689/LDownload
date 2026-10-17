using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

internal static class BrowserNativeHost
{
    private const int MaxMessageBytes = 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxMessageBytes };

    private static int Main()
    {
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        while (true)
        {
            try
            {
                byte[] header = new byte[4];
                if (!ReadFramePart(input, header, 4, true)) return 0;
                int length = BitConverter.ToInt32(header, 0);
                if (length < 0 || length > MaxMessageBytes)
                {
                    WriteResponse(output, false, "Native message size is invalid.");
                    return 2;
                }
                byte[] payload = new byte[length];
                if (!ReadFramePart(input, payload, length, false))
                {
                    WriteResponse(output, false, "Native message ended before the payload was complete.");
                    return 2;
                }

                Dictionary<string, object> message = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
                bool accepted = HandleMessage(message);
                WriteResponse(output, accepted, accepted ? null : "LDownload rejected the native message.");
            }
            catch (Exception error)
            {
                WriteResponse(output, false, error.Message);
                return 1;
            }
        }
    }

    private static bool ReadFramePart(Stream input, byte[] buffer, int count, bool allowCleanEof)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(buffer, offset, count - offset);
            if (read == 0)
            {
                if (offset == 0 && allowCleanEof) return false;
                return false;
            }
            offset += read;
        }
        return true;
    }

    private static bool HandleMessage(Dictionary<string, object> message)
    {
        if (message == null) return false;
        string type = GetString(message, "type");
        string captureId = GetString(message, "captureId");
        object rawTrace;
        message.TryGetValue("diagnostics", out rawTrace);
        string trace = EncodeTrace(rawTrace);

        if (type == "diagnostic")
        {
            string uri = "ldownload://diagnostics?captureId=" + Uri.EscapeDataString(ValidCaptureId(captureId) ? captureId : "") + "&trace=" + trace;
            return LaunchApplication(uri);
        }
        if (type != "download") return false;

        object rawUrls;
        if (!message.TryGetValue("urls", out rawUrls)) return false;
        IEnumerable rawValues = rawUrls as IEnumerable;
        if (rawValues == null || rawUrls is string) return false;
        List<object> values = new List<object>();
        foreach (object value in rawValues) values.Add(value);
        if (values.Count < 1 || values.Count > 100) return false;

        StringBuilder uriBuilder = new StringBuilder("ldownload://add?");
        int acceptedCount = 0;
        foreach (object value in values)
        {
            string url = value as string;
            Uri parsed;
            if (String.IsNullOrWhiteSpace(url) || url.Length > 8192 || !Uri.TryCreate(url, UriKind.Absolute, out parsed)) continue;
            string scheme = parsed.Scheme.ToLowerInvariant();
            if ((scheme != "http" && scheme != "https" && scheme != "ftp" && scheme != "ftps") || !String.IsNullOrEmpty(parsed.UserInfo)) continue;
            if (acceptedCount > 0) uriBuilder.Append('&');
            uriBuilder.Append("url=").Append(Uri.EscapeDataString(url));
            acceptedCount++;
        }
        if (acceptedCount == 0) return false;
        uriBuilder.Append("&autoStart=0");
        if (ValidCaptureId(captureId)) uriBuilder.Append("&captureId=").Append(Uri.EscapeDataString(captureId));
        if (trace.Length > 0) uriBuilder.Append("&trace=").Append(trace);
        return LaunchApplication(uriBuilder.ToString());
    }

    private static string EncodeTrace(object rawTrace)
    {
        IEnumerable rawRows = rawTrace as IEnumerable;
        if (rawRows == null || rawTrace is string) return "";
        List<object> rows = new List<object>();
        foreach (object row in rawRows) rows.Add(row);
        if (rows.Count == 0) return "";
        ArrayList safeRows = new ArrayList();
        int start = Math.Max(0, rows.Count - 40);
        for (int i = start; i < rows.Count; i++)
        {
            Dictionary<string, object> row = rows[i] as Dictionary<string, object>;
            if (row == null) continue;
            string step = GetString(row, "step");
            if (step.Length == 0 || step.Length > 64) continue;
            Dictionary<string, object> safe = new Dictionary<string, object>();
            safe["step"] = step;
            string detail = GetString(row, "message");
            safe["message"] = detail.Substring(0, Math.Min(500, detail.Length));
            safeRows.Add(safe);
        }
        if (safeRows.Count == 0) return "";
        string json = Json.Serialize(safeRows);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static bool LaunchApplication(string uri)
    {
        string helperDirectory = Path.GetDirectoryName(typeof(BrowserNativeHost).Assembly.Location);
        string resourcesDirectory = Directory.GetParent(helperDirectory).FullName;
        string installDirectory = Directory.GetParent(resourcesDirectory).FullName;
        string executable = Path.Combine(installDirectory, "LDownload.exe");
        string arguments = "\"" + uri.Replace("\"", "\\\"") + "\"";
        if (!File.Exists(executable))
        {
            executable = Path.Combine(installDirectory, "node_modules", "electron", "dist", "electron.exe");
            if (!File.Exists(executable)) return false;
            arguments = "\"" + installDirectory + "\" " + arguments;
        }

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = arguments;
        start.WorkingDirectory = installDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process process = Process.Start(start);
        if (process == null) return false;
        process.Dispose();
        return true;
    }

    private static void WriteResponse(Stream output, bool accepted, string error)
    {
        Dictionary<string, object> response = new Dictionary<string, object>();
        response["accepted"] = accepted;
        if (!String.IsNullOrEmpty(error)) response["error"] = error.Substring(0, Math.Min(500, error.Length));
        byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(response));
        byte[] header = BitConverter.GetBytes(payload.Length);
        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    private static string GetString(Dictionary<string, object> values, string key)
    {
        object value;
        return values != null && values.TryGetValue(key, out value) && value is string ? (string)value : "";
    }


    private static bool ValidCaptureId(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length < 8 || value.Length > 80) return false;
        foreach (char character in value)
        {
            if (!Char.IsLetterOrDigit(character) && character != '-') return false;
        }
        return true;
    }
}
