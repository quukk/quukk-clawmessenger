//go:build windows

package daemon

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type codexDesktopExecutable struct {
	path    string
	updated time.Time
}

func platformCodexDesktopExecutablePaths() []string {
	localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if localAppData == "" {
		return nil
	}
	pattern := filepath.Join(localAppData, "OpenAI", "Codex", "bin", "*", "codex.exe")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil
	}
	candidates := make([]codexDesktopExecutable, 0, len(matches))
	for _, path := range matches {
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		candidates = append(candidates, codexDesktopExecutable{path: path, updated: info.ModTime()})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].updated.Equal(candidates[j].updated) {
			return candidates[i].path < candidates[j].path
		}
		return candidates[i].updated.After(candidates[j].updated)
	})
	paths := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		paths = append(paths, candidate.path)
	}
	return paths
}
