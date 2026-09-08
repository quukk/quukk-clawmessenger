package agent

import (
	"errors"
	"os/exec"
	"time"
)

// ErrProcessTreeStopUnconfirmed preserves uncertain launch cleanup across the
// Backend.Execute error boundary, before a Session can be returned.
var ErrProcessTreeStopUnconfirmed = errors.New("process tree stop unconfirmed")

// Interactive work and readiness probes require ownership for each new launch.
// Legacy runtime launches retain their existing best-effort ownership policy.
type processTreeStartOptions struct {
	requireOwnership bool
	takeOwnership    func(*exec.Cmd) error
	waitStopped      func(*exec.Cmd, time.Duration) bool
	stopSuspended    func(*exec.Cmd) error
	resume           func(int) error
}

func (cfg Config) processStartOptions(opts ExecOptions) processTreeStartOptions {
	policy := cfg.processTreeOptions
	policy.requireOwnership = opts.RequireProcessTree
	return policy
}

func (cfg Config) processTreeStopped(cmd *exec.Cmd, timeout time.Duration) bool {
	if cfg.processTreeOptions.waitStopped != nil {
		return cfg.processTreeOptions.waitStopped(cmd, timeout)
	}
	return waitProcessGroupGone(cmd, timeout)
}
