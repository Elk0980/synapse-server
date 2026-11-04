# Локальный Windows-supervisor. Job handle живёт до выхода PowerShell и не наследуется.
# Закрытие последнего handle ядром при выходе завершает все оставшиеся дочерние процессы.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class SynapseAgentJob {
    static IntPtr Job;
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED {
        public BASIC BasicLimitInformation;
        public IO IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static string Quote(string value) {
        StringBuilder b = new StringBuilder("\""); int slash = 0;
        foreach (char c in value) {
            if (c == '\\') { slash++; continue; }
            if (c == '"') { b.Append('\\', slash * 2 + 1); b.Append(c); slash = 0; continue; }
            b.Append('\\', slash); slash = 0; b.Append(c);
        }
        b.Append('\\', slash * 2); b.Append('"'); return b.ToString();
    }
    public static int Run(string executable, string[] arguments, string input) {
        Job = CreateJobObject(IntPtr.Zero, null);
        EXTENDED limits = new EXTENDED(); limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        if (Job == IntPtr.Zero || !SetInformationJobObject(Job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED))) ||
            !AssignProcessToJobObject(Job, Process.GetCurrentProcess().Handle)) throw new InvalidOperationException("JOB_REQUIRED");
        StringBuilder command = new StringBuilder();
        foreach (string argument in arguments) { if (command.Length != 0) command.Append(' '); command.Append(Quote(argument)); }
        ProcessStartInfo start = new ProcessStartInfo(executable, command.ToString());
        start.UseShellExecute = false; start.CreateNoWindow = true; start.RedirectStandardInput = true;
        // stdout/stderr наследуют handles supervisor: JSONL идёт родителю сразу, без PowerShell pipeline.
        using (Process child = Process.Start(start)) {
            child.StandardInput.Write(input); child.StandardInput.Close(); child.WaitForExit(); return child.ExitCode;
        }
        // Job намеренно НЕ закрываем здесь: supervisor сам входит в Job. Handle закроет ОС при exit.
    }
}
'@
    $command = $env:TASKS_AGENT_EXEC_JSON | ConvertFrom-Json
    [Environment]::SetEnvironmentVariable('TASKS_AGENT_EXEC_JSON', $null)
    if (-not $command.executable -or $null -eq $command.arguments) { throw 'COMMAND_REQUIRED' }
    $inputText = [Console]::In.ReadToEnd()
    $exitCode = [SynapseAgentJob]::Run([string]$command.executable, [string[]]$command.arguments, $inputText)
    exit $exitCode
} catch {
    [Console]::Error.WriteLine('AGENT_SUPERVISOR_FAILED')
    exit 125
}
