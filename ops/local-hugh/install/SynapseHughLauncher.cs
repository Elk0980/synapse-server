// Скрытый запускатель локального обработчика Хью.
//
// Планировщик Windows не прячет окно консоли Node даже с флагом Hidden, поэтому задача
// запускает этот WinExe без окна. Он поднимает node.exe с CreateNoWindow, ждёт выхода и
// возвращает его код выхода — планировщик видит сбой и перезапускает задачу.
//
// Дополнительно:
// - именованный mutex Local\SynapseHughWorker: второй экземпляр молча выходит с кодом 0;
// - Job Object с KILL_ON_JOB_CLOSE: если запускатель завершат, node.exe тоже закроется.
//
// Компилируется установщиком через Add-Type -OutputType WindowsApplication. Аргументы:
//   SynapseHughLauncher.exe <node.exe> <main.js> <config.json>

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace SynapseHugh
{
    internal static class Launcher
    {
        private const string MutexName = @"Local\SynapseHughWorker";
        private const uint JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        private static string Quote(string value)
        {
            // Правило разбора аргументов CommandLineToArgvW: кавычки и обратные слэши перед ними.
            var builder = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in value)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    builder.Append('\\', backslashes * 2 + 1).Append('"');
                    backslashes = 0;
                    continue;
                }
                builder.Append('\\', backslashes).Append(c);
                backslashes = 0;
            }
            builder.Append('\\', backslashes * 2).Append('"');
            return builder.ToString();
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)length)) return IntPtr.Zero;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            return job;
        }

        private static int Main(string[] args)
        {
            if (args.Length < 3) return 2;
            string node = args[0];
            string script = args[1];
            string config = args[2];
            if (!File.Exists(node) || !File.Exists(script) || !File.Exists(config)) return 3;

            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created) return 0; // экземпляр уже работает — это не сбой

                IntPtr job = CreateKillOnCloseJob();
                var start = new ProcessStartInfo(node, Quote(script) + " " + Quote(config));
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                start.WorkingDirectory = Path.GetDirectoryName(config);
                // Ключ worker через окружение не передаётся: main.js читает его сам из keyFile.

                using (Process process = Process.Start(start))
                {
                    if (process == null) return 4;
                    if (job != IntPtr.Zero) AssignProcessToJobObject(job, process.Handle);
                    process.WaitForExit();
                    int code = process.ExitCode;
                    mutex.ReleaseMutex();
                    return code;
                }
            }
        }
    }
}
