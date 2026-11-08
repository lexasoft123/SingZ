// Task Scheduler starts this GUI-subsystem host so PowerShell never creates a
// console window before it can process -WindowStyle Hidden. No window is created.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

internal static class WindowsHiddenRunner {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")] private static extern uint SetErrorMode(uint mode);

    private static int Main(string[] args) {
        if (args.Length != 2 || !File.Exists(args[0]) || args[0].Contains("\"")) return 2;
        string prefix = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(Path.GetDirectoryName(prefix));
        SetErrorMode(0x8003);
        long before = GetForegroundWindow().ToInt64();
        int result = 1;
        try {
            var options = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                                        @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
                            Path.GetFullPath(args[0]) + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            using (var process = Process.Start(options)) {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                File.WriteAllText(prefix + ".stdout.log", output.GetAwaiter().GetResult(), Encoding.UTF8);
                File.WriteAllText(prefix + ".stderr.log", error.GetAwaiter().GetResult(), Encoding.UTF8);
                result = process.ExitCode;
            }
        } catch (Exception error) {
            File.WriteAllText(prefix + ".host-error.log", error.ToString(), Encoding.UTF8);
        }
        long after = GetForegroundWindow().ToInt64();
        if (before != after && result == 0) result = 1;
        File.WriteAllText(prefix + ".json", "{\"hostPid\":" + Process.GetCurrentProcess().Id +
            ",\"foregroundBefore\":" + before + ",\"foregroundAfter\":" + after +
            ",\"foregroundUnchanged\":" + (before == after ? "true" : "false") +
            ",\"exitCode\":" + result + "}", Encoding.UTF8);
        return result;
    }
}
