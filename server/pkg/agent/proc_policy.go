package agent

import "os/exec"

// A readiness probe must not run when descendant cleanup cannot be guaranteed.
// Legacy runtime launches retain their existing best-effort ownership policy.
type processTreeStartOptions struct {
	requireOwnership bool
	takeOwnership    func(*exec.Cmd) error
}
