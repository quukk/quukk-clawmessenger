//go:build !windows

package daemon

func platformCodexDesktopExecutablePaths() []string {
	return codexDesktopAppBundlePaths()
}
