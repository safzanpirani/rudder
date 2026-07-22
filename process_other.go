//go:build !unix && !windows

package main

import "os/exec"

func configureChildProcess(cmd *exec.Cmd) {}

func terminateProcessTree(cmd *exec.Cmd, force bool) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
