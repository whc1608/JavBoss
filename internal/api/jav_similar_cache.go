package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"javboss/internal/common"
	"javboss/internal/common/logging"
)

var javSimilarDiskCacheOnce sync.Once

func javSimilarDiskCachePath() string {
	cfg := common.CurrentConfig()
	if cfg == nil {
		return ""
	}
	base := filepath.Dir(cfg.DatabasePath)
	if base == "" || base == "." {
		return ""
	}
	return filepath.Join(base, "cache", "jav-similar-cache.json")
}

// loadSimilarCacheFromDisk restores today's recommendation entries so a server
// restart does not force the first click of the day to fetch JavDB again.
func loadSimilarCacheFromDisk() {
	javSimilarDiskCacheOnce.Do(func() {
		path := javSimilarDiskCachePath()
		if path == "" {
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				logging.Error("read similar cache: %v", err)
			}
			return
		}
		var entries []javSimilarFreshEntry
		if err := json.Unmarshal(data, &entries); err != nil {
			logging.Error("decode similar cache: %v", err)
			return
		}
		day := time.Now().Format("2006-01-02")
		javSimilarFreshMu.Lock()
		defer javSimilarFreshMu.Unlock()
		for _, entry := range entries {
			if entry.SourceID <= 0 || entry.Day != day || len(entry.Items) == 0 {
				continue
			}
			javSimilarFreshToday[entry.SourceID] = entry
			javSimilarFreshLast[entry.SourceID] = entry
		}
	})
}

func persistSimilarCache() {
	path := javSimilarDiskCachePath()
	if path == "" {
		return
	}
	day := time.Now().Format("2006-01-02")
	javSimilarFreshMu.Lock()
	entries := make([]javSimilarFreshEntry, 0, len(javSimilarFreshToday))
	for _, entry := range javSimilarFreshToday {
		if entry.Day == day && entry.SourceID > 0 {
			entries = append(entries, entry)
		}
	}
	javSimilarFreshMu.Unlock()
	if len(entries) == 0 {
		return
	}
	data, err := json.Marshal(entries)
	if err != nil {
		logging.Error("encode similar cache: %v", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logging.Error("create similar cache dir: %v", err)
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		logging.Error("write similar cache: %v", err)
	}
}
