package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"javboss/internal/common"
	"javboss/internal/common/logging"
	dbpkg "javboss/internal/db"
)

// javOnlineRelatedItem is one related work scraped from an online site.
type javOnlineRelatedItem struct {
	Code     string `json:"code"`
	Title    string `json:"title"`
	Duration string `json:"duration"`
	CoverURL string `json:"cover_url"`
}

// javOnlineRelatedEntry groups the related works of a single library code.
type javOnlineRelatedEntry struct {
	Site      string                 `json:"site"`
	FetchedAt time.Time              `json:"fetched_at"`
	Items     []javOnlineRelatedItem `json:"items"`
}

// javOnlineRelatedFile mirrors data/cache/jav-online-related.json, produced by
// scripts/online-related/fetch-online-related.mjs.
type javOnlineRelatedFile struct {
	Entries   map[string]javOnlineRelatedEntry `json:"entries"`
	UpdatedAt string                           `json:"updated_at"`
	Site      string                           `json:"site"`
}

const (
	javOnlineRelatedStatInterval = 5 * time.Second
	// The client pages through these candidates five at a time, so return the
	// whole related batch instead of a single page.
	javOnlineRelatedMaxItems = 20
)

var (
	javOnlineRelatedMu      sync.Mutex
	javOnlineRelatedEntries map[string]javOnlineRelatedEntry
	javOnlineRelatedModTime time.Time
	javOnlineRelatedSize    int64
	javOnlineRelatedChecked time.Time
	javOnlineRelatedLoaded  bool
)

func javOnlineRelatedPath() string {
	cfg := common.CurrentConfig()
	if cfg == nil {
		return ""
	}
	base := filepath.Dir(cfg.DatabasePath)
	if base == "" || base == "." {
		return ""
	}
	return filepath.Join(base, "cache", "jav-online-related.json")
}

// loadOnlineRelated refreshes the in-memory copy when the cache file changes on
// disk. The cache never expires: it only changes when the operator re-runs the
// scraping script, so rebuilds and redeploys keep serving the same data. Callers
// pass force to bypass the stat throttle, which is what the UI refresh uses.
func loadOnlineRelated(force bool) {
	path := javOnlineRelatedPath()
	if path == "" {
		return
	}
	now := time.Now()
	javOnlineRelatedMu.Lock()
	recent := !force && javOnlineRelatedLoaded && now.Sub(javOnlineRelatedChecked) < javOnlineRelatedStatInterval
	javOnlineRelatedMu.Unlock()
	if recent {
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		javOnlineRelatedMu.Lock()
		if !javOnlineRelatedLoaded || len(javOnlineRelatedEntries) > 0 {
			javOnlineRelatedEntries = map[string]javOnlineRelatedEntry{}
			javOnlineRelatedLoaded = true
		}
		javOnlineRelatedChecked = now
		javOnlineRelatedModTime = time.Time{}
		javOnlineRelatedSize = 0
		javOnlineRelatedMu.Unlock()
		if !os.IsNotExist(err) {
			logging.Error("stat online related cache: %v", err)
		}
		return
	}

	javOnlineRelatedMu.Lock()
	unchanged := !force && javOnlineRelatedLoaded &&
		info.ModTime().Equal(javOnlineRelatedModTime) &&
		info.Size() == javOnlineRelatedSize
	javOnlineRelatedMu.Unlock()
	if unchanged {
		javOnlineRelatedMu.Lock()
		javOnlineRelatedChecked = now
		javOnlineRelatedMu.Unlock()
		return
	}

	data, readErr := os.ReadFile(path)
	if readErr != nil {
		logging.Error("read online related cache: %v", readErr)
		return
	}
	var file javOnlineRelatedFile
	if err := json.Unmarshal(data, &file); err != nil {
		logging.Error("decode online related cache: %v", err)
		return
	}
	entries := make(map[string]javOnlineRelatedEntry, len(file.Entries))
	for code, entry := range file.Entries {
		key := strings.ToUpper(strings.TrimSpace(code))
		if key == "" || len(entry.Items) == 0 {
			continue
		}
		entries[key] = entry
	}
	javOnlineRelatedMu.Lock()
	javOnlineRelatedEntries = entries
	javOnlineRelatedLoaded = true
	javOnlineRelatedChecked = now
	javOnlineRelatedModTime = info.ModTime()
	javOnlineRelatedSize = info.Size()
	javOnlineRelatedMu.Unlock()
	logging.Info("loaded online related cache: %d codes", len(entries))
}

func lookupOnlineRelated(code string, force bool) (javOnlineRelatedEntry, bool) {
	loadOnlineRelated(force)
	key := strings.ToUpper(strings.TrimSpace(code))
	if key == "" {
		return javOnlineRelatedEntry{}, false
	}
	javOnlineRelatedMu.Lock()
	defer javOnlineRelatedMu.Unlock()
	entry, ok := javOnlineRelatedEntries[key]
	if !ok || len(entry.Items) == 0 {
		return javOnlineRelatedEntry{}, false
	}
	return entry, true
}

// mapOnlineRelated turns cached online entries into recommendation rows,
// enriching them with library metadata whenever the code exists locally.
func mapOnlineRelated(ctx context.Context, entry javOnlineRelatedEntry) []javSimilarFreshItem {
	codes := make([]string, 0, len(entry.Items))
	for _, item := range entry.Items {
		if code := strings.TrimSpace(item.Code); code != "" {
			codes = append(codes, code)
		}
	}
	byCode := map[string]dbpkg.JavCodeInfo{}
	if rows, err := dbpkg.Default().ListJavsByCodes(ctx, codes); err != nil {
		logging.Error("map online related codes: %v", err)
	} else {
		for _, row := range rows {
			byCode[strings.ToUpper(strings.TrimSpace(row.Code))] = row
		}
	}
	items := make([]javSimilarFreshItem, 0, len(entry.Items))
	for _, item := range entry.Items {
		code := strings.TrimSpace(item.Code)
		if code == "" {
			continue
		}
		row := javSimilarFreshItem{
			Code:     code,
			Title:    strings.TrimSpace(item.Title),
			CoverURL: strings.TrimSpace(item.CoverURL),
			External: true,
		}
		if local, ok := byCode[strings.ToUpper(code)]; ok {
			row.ID = local.ID
			row.FavoriteRating = local.FavoriteRating
			row.Local = local.HasLocal
			row.External = false
			if zhTitle := strings.TrimSpace(local.ZhTitle); zhTitle != "" {
				row.ZhTitle = zhTitle
			}
			if title := strings.TrimSpace(local.Title); title != "" {
				row.Title = title
			}
		}
		items = append(items, row)
		if len(items) >= javOnlineRelatedMaxItems {
			break
		}
	}
	return items
}

// respondOnlineRelated serves recommendations straight from the persistent
// on-disk cache, so no upstream request happens at click time. It reports
// whether a response was written.
func respondOnlineRelated(c *gin.Context, entry javOnlineRelatedEntry, includeLocal bool) bool {
	items := mapOnlineRelated(c.Request.Context(), entry)
	if !includeLocal {
		filtered := make([]javSimilarFreshItem, 0, len(items))
		for _, item := range items {
			if item.Local {
				continue
			}
			filtered = append(filtered, item)
		}
		items = filtered
	}
	if len(items) == 0 {
		return false
	}
	c.JSON(http.StatusOK, gin.H{
		"items":      items,
		"total":      len(items),
		"stale":      false,
		"cached":     true,
		"source":     "online",
		"site":       entry.Site,
		"day":        entry.FetchedAt.Format("2006-01-02"),
		"fetched_at": entry.FetchedAt.Format(time.RFC3339),
	})
	return true
}

// onlineRelatedStatus reports cache freshness for the settings UI and scripts.
func onlineRelatedStatus() (int, time.Time, string) {
	loadOnlineRelated(false)
	javOnlineRelatedMu.Lock()
	defer javOnlineRelatedMu.Unlock()
	latest := time.Time{}
	for _, entry := range javOnlineRelatedEntries {
		if entry.FetchedAt.After(latest) {
			latest = entry.FetchedAt
		}
	}
	site := ""
	for _, entry := range javOnlineRelatedEntries {
		if entry.Site != "" {
			site = entry.Site
			break
		}
	}
	return len(javOnlineRelatedEntries), latest, site
}

// getJavOnlineRelatedStatus exposes how many codes are cached and when the data
// was last refreshed by the scraping script.
func getJavOnlineRelatedStatus(c *gin.Context) {
	count, latest, site := onlineRelatedStatus()
	payload := gin.H{
		"codes":   count,
		"site":    site,
		"path":    javOnlineRelatedPath(),
		"cached":  count > 0,
		"expires": false,
	}
	if !latest.IsZero() {
		payload["latest_fetched_at"] = latest.Format(time.RFC3339)
	}
	c.JSON(http.StatusOK, payload)
}
