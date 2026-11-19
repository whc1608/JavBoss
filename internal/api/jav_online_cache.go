package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
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
	// The client pages through candidates five at a time, so extra candidates
	// mined from neighbouring batches are capped but still worth 4+ pages.
	javOnlineRelatedExtraLimit = 20
)

// javOnlineRelatedIndex maps a library code to the related codes of its own
// batch; javOnlineRelatedMeta keeps one row per known code so cross-film
// expansion can still render covers and titles.
var (
	javOnlineRelatedMu      sync.Mutex
	javOnlineRelatedEntries map[string]javOnlineRelatedEntry
	javOnlineRelatedIndex   map[string][]string
	javOnlineRelatedMeta    map[string]javOnlineRelatedItem
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
	index := make(map[string][]string, len(file.Entries))
	meta := make(map[string]javOnlineRelatedItem, len(file.Entries)*8)
	for code, entry := range file.Entries {
		key := strings.ToUpper(strings.TrimSpace(code))
		if key == "" || len(entry.Items) == 0 {
			continue
		}
		entries[key] = entry
		codes := make([]string, 0, len(entry.Items))
		for _, item := range entry.Items {
			related := strings.ToUpper(strings.TrimSpace(item.Code))
			if related == "" {
				continue
			}
			codes = append(codes, related)
			if _, seen := meta[related]; !seen {
				item.Code = related
				meta[related] = item
			}
		}
		index[key] = codes
	}
	javOnlineRelatedMu.Lock()
	javOnlineRelatedEntries = entries
	javOnlineRelatedIndex = index
	javOnlineRelatedMeta = meta
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

// mapOnlineRelatedRows turns cached online rows into recommendation rows,
// enriching them with library metadata whenever the code exists locally.
func mapOnlineRelatedRows(ctx context.Context, rows []javOnlineRelatedItem) []javSimilarFreshItem {
	codes := make([]string, 0, len(rows))
	for _, item := range rows {
		if code := strings.TrimSpace(item.Code); code != "" {
			codes = append(codes, code)
		}
	}
	byCode := map[string]dbpkg.JavCodeInfo{}
	if locals, err := dbpkg.Default().ListJavsByCodes(ctx, codes); err != nil {
		logging.Error("map online related codes: %v", err)
	} else {
		for _, local := range locals {
			byCode[strings.ToUpper(strings.TrimSpace(local.Code))] = local
		}
	}
	items := make([]javSimilarFreshItem, 0, len(rows))
	for _, item := range rows {
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
	}
	return items
}

// expandOnlineRelated mines the related batches of neighbouring works for
// extra candidates. A code recommended by several neighbours, and at a high
// position inside each batch, is likely relevant to the source work too.
// primarySeeds are the source's own related works, neighbourSeeds the library
// works that resemble the source; both are ordered by relevance.
func expandOnlineRelated(primarySeeds, neighbourSeeds []string, exclude map[string]bool, limit int) []javOnlineRelatedItem {
	javOnlineRelatedMu.Lock()
	index := javOnlineRelatedIndex
	meta := javOnlineRelatedMeta
	javOnlineRelatedMu.Unlock()

	scores := make(map[string]float64, 64)
	support := make(map[string]int, 64)
	visited := make(map[string]bool, len(primarySeeds)+len(neighbourSeeds))
	accumulate := func(seed string, weight float64) {
		key := strings.ToUpper(strings.TrimSpace(seed))
		if key == "" || visited[key] {
			return
		}
		visited[key] = true
		related := index[key]
		if len(related) == 0 {
			return
		}
		for position, candidate := range related {
			if exclude[candidate] {
				continue
			}
			scores[candidate] += weight / float64(position+2)
			support[candidate]++
		}
	}
	for rank, seed := range primarySeeds {
		accumulate(seed, 1.0/float64(rank+2))
	}
	// Library neighbours matter, but less than the source's own related works.
	for rank, seed := range neighbourSeeds {
		accumulate(seed, 0.6/float64(rank+2))
	}

	type rankedCandidate struct {
		code  string
		score float64
	}
	// Candidates recommended by two or more neighbours lead; single hits only
	// fill the remaining slots, since one neighbour alone is a weak signal.
	strong := make([]rankedCandidate, 0, len(scores))
	weak := make([]rankedCandidate, 0, len(scores))
	for code, score := range scores {
		if support[code] >= 2 {
			strong = append(strong, rankedCandidate{code: code, score: score})
			continue
		}
		weak = append(weak, rankedCandidate{code: code, score: score})
	}
	byScore := func(list []rankedCandidate) {
		sort.Slice(list, func(left, right int) bool {
			if list[left].score != list[right].score {
				return list[left].score > list[right].score
			}
			return list[left].code < list[right].code
		})
	}
	byScore(strong)
	byScore(weak)
	ranked := append(strong, weak...)
	if limit > 0 && len(ranked) > limit {
		ranked = ranked[:limit]
	}
	out := make([]javOnlineRelatedItem, 0, len(ranked))
	for _, row := range ranked {
		item, ok := meta[row.code]
		if !ok {
			item = javOnlineRelatedItem{Code: row.code}
		}
		out = append(out, item)
	}
	return out
}

// respondOnlineRelated serves recommendations straight from the persistent
// on-disk cache, so no upstream request happens at click time. Besides the
// batch of the source itself it appends candidates mined from neighbouring
// batches, which gives the client more pages to rotate through.
func respondOnlineRelated(c *gin.Context, sourceID int64, sourceCode string, entry javOnlineRelatedEntry, includeLocal bool) bool {
	primary := entry.Items
	exclude := make(map[string]bool, len(primary)+1)
	if code := strings.ToUpper(strings.TrimSpace(sourceCode)); code != "" {
		exclude[code] = true
	}
	primarySeeds := make([]string, 0, len(primary))
	for _, item := range primary {
		code := strings.ToUpper(strings.TrimSpace(item.Code))
		if code == "" {
			continue
		}
		exclude[code] = true
		primarySeeds = append(primarySeeds, code)
	}
	var neighbourSeeds []string
	if sourceID > 0 {
		if neighbours, err := dbpkg.Default().ListSimilarJavs(c.Request.Context(), sourceID, 20, true); err != nil {
			logging.Error("list neighbour javs for online related id=%d: %v", sourceID, err)
		} else {
			neighbourSeeds = make([]string, 0, len(neighbours))
			for _, neighbour := range neighbours {
				neighbourSeeds = append(neighbourSeeds, neighbour.Code)
			}
		}
	}
	rows := make([]javOnlineRelatedItem, 0, len(primary)+javOnlineRelatedExtraLimit)
	rows = append(rows, primary...)
	extra := expandOnlineRelated(primarySeeds, neighbourSeeds, exclude, javOnlineRelatedExtraLimit)
	for _, item := range extra {
		if code := strings.ToUpper(strings.TrimSpace(item.Code)); code != "" {
			if exclude[code] {
				continue
			}
			exclude[code] = true
		}
		rows = append(rows, item)
	}
	items := mapOnlineRelatedRows(c.Request.Context(), rows)
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
