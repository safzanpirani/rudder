//go:build windows

package main

import (
	"os/exec"
	"strconv"
)

func configureChildProcess(cmd *exec.Cmd) {}

func terminateProcessTree(cmd *exec.Cmd, _ bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := exec.Command("taskkill.exe", windowsTaskkillArgs(cmd.Process.Pid)...).Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}

func windowsTaskkillArgs(pid int) []string {
	return []string{"/PID", strconv.Itoa(pid), "/T", "/F"}
}
