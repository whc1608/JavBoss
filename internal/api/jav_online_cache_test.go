package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"javboss/internal/common"
)

func resetJavOnlineRelatedCacheForTest() {
	javOnlineRelatedMu.Lock()
	javOnlineRelatedEntries = nil
	javOnlineRelatedIndex = nil
	javOnlineRelatedMeta = nil
	javOnlineRelatedLoaded = false
	javOnlineRelatedChecked = time.Time{}
	javOnlineRelatedModTime = time.Time{}
	javOnlineRelatedSize = 0
	javOnlineRelatedMu.Unlock()
}

func useJavOnlineRelatedDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	previous := common.SetConfig(&common.Config{DatabasePath: filepath.Join(dir, "javboss.db")})
	t.Cleanup(func() {
		common.SetConfig(previous)
		resetJavOnlineRelatedCacheForTest()
	})
	resetJavOnlineRelatedCacheForTest()
	return dir
}

func writeJavOnlineRelatedCache(t *testing.T, dir, body string) {
	t.Helper()
	cacheDir := filepath.Join(dir, "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatalf("create cache dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "jav-online-related.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write cache: %v", err)
	}
}

func TestLookupOnlineRelatedReturnsCachedEntry(t *testing.T) {
	dir := useJavOnlineRelatedDir(t)
	writeJavOnlineRelatedCache(t, dir, `{
		"entries": {
			"abc-123": {
				"site": "MissAV",
				"fetched_at": "2026-11-19T14:17:20.407Z",
				"items": [
					{"code": "XYZ-001", "title": "示例标题", "duration": "2:00:00", "cover_url": "https://example.com/xyz-001.jpg"}
				]
			}
		},
		"updated_at": "2026-11-19T14:20:00Z",
		"site": "MissAV"
	}`)

	entry, ok := lookupOnlineRelated("ABC-123", false)
	if !ok {
		t.Fatal("expected cached entry for ABC-123")
	}
	if entry.Site != "MissAV" {
		t.Fatalf("site = %q, want MissAV", entry.Site)
	}
	if entry.FetchedAt.IsZero() {
		t.Fatal("fetched_at was not parsed")
	}
	if len(entry.Items) != 1 || entry.Items[0].Code != "XYZ-001" {
		t.Fatalf("items = %+v, want one XYZ-001 row", entry.Items)
	}
}

func TestLookupOnlineRelatedIgnoresEmptyAndMissingEntries(t *testing.T) {
	dir := useJavOnlineRelatedDir(t)
	writeJavOnlineRelatedCache(t, dir, `{"entries":{"EMPTY-001":{"site":"MissAV","items":[]}}}`)

	if _, ok := lookupOnlineRelated("EMPTY-001", false); ok {
		t.Fatal("entries without items must be ignored")
	}
	if _, ok := lookupOnlineRelated("MISSING-001", false); ok {
		t.Fatal("unknown code must not resolve")
	}
}

func TestLookupOnlineRelatedPreservesItemOrder(t *testing.T) {
	dir := useJavOnlineRelatedDir(t)
	writeJavOnlineRelatedCache(t, dir, `{
		"entries": {
			"PREF-001": {
				"site": "MissAV",
				"fetched_at": "2026-11-19T14:17:20.407Z",
				"items": [{"code": "PREF-002", "title": "推荐一"}, {"code": "PREF-003", "title": "推荐二"}]
			}
		}
	}`)

	entry, ok := lookupOnlineRelated("pref-001", false)
	if !ok || len(entry.Items) != 2 {
		t.Fatalf("lookup returned %+v (ok=%v), want 2 items", entry, ok)
	}
	if entry.Items[1].Title != "推荐二" {
		t.Fatalf("item title = %q, want 推荐二", entry.Items[1].Title)
	}
}

func TestExpandOnlineRelatedMinesNeighbourBatches(t *testing.T) {
	resetJavOnlineRelatedCacheForTest()
	t.Cleanup(resetJavOnlineRelatedCacheForTest)
	javOnlineRelatedMu.Lock()
	javOnlineRelatedIndex = map[string][]string{
		"AAA-001": {"BBB-001", "CCC-001"},
		"AAA-002": {"BBB-001", "DDD-001"},
		"AAA-003": {"CCC-001", "DDD-001"},
	}
	javOnlineRelatedMeta = map[string]javOnlineRelatedItem{
		"BBB-001": {Code: "BBB-001", Title: "B"},
		"CCC-001": {Code: "CCC-001", Title: "C"},
		"DDD-001": {Code: "DDD-001", Title: "D"},
	}
	javOnlineRelatedMu.Unlock()

	got := expandOnlineRelated([]string{"AAA-001", "AAA-002", "AAA-003"}, nil, map[string]bool{}, 10)
	if len(got) != 3 {
		t.Fatalf("expanded rows = %+v, want 3 candidates", got)
	}
	// BBB-001 is recommended by the two highest ranked seeds, so it must lead.
	wantOrder := []string{"BBB-001", "CCC-001", "DDD-001"}
	for index, want := range wantOrder {
		if got[index].Code != want {
			t.Fatalf("row %d = %q, want %q (full %+v)", index, got[index].Code, want, got)
		}
	}
	if got[0].Title != "B" {
		t.Fatalf("expanded row lost metadata: %+v", got[0])
	}

	excluded := expandOnlineRelated([]string{"AAA-001", "AAA-002", "AAA-003"}, nil, map[string]bool{"BBB-001": true}, 10)
	for _, row := range excluded {
		if row.Code == "BBB-001" {
			t.Fatal("excluded code must not be expanded")
		}
	}
}

// Candidates backed by a single neighbour only fill the remaining slots and
// must never outrank candidates recommended by several neighbours.
func TestExpandOnlineRelatedRanksWeakCandidatesLast(t *testing.T) {
	resetJavOnlineRelatedCacheForTest()
	t.Cleanup(resetJavOnlineRelatedCacheForTest)
	javOnlineRelatedMu.Lock()
	javOnlineRelatedIndex = map[string][]string{
		"AAA-001": {"STRONG-001"},
		"AAA-002": {"STRONG-001"},
		"AAA-003": {"WEAK-001"},
	}
	javOnlineRelatedMeta = map[string]javOnlineRelatedItem{
		"STRONG-001": {Code: "STRONG-001"},
		"WEAK-001":   {Code: "WEAK-001"},
	}
	javOnlineRelatedMu.Unlock()

	got := expandOnlineRelated([]string{"AAA-001", "AAA-002", "AAA-003"}, nil, map[string]bool{}, 10)
	if len(got) != 2 {
		t.Fatalf("expanded rows = %+v, want strong and weak candidates", got)
	}
	if got[0].Code != "STRONG-001" || got[1].Code != "WEAK-001" {
		t.Fatalf("order = [%s %s], want [STRONG-001 WEAK-001]", got[0].Code, got[1].Code)
	}
}

// The UI refresh must pick up a re-scraped file even when the stat throttle
// would otherwise serve the cached copy for a few more seconds.
func TestLookupOnlineRelatedForceReloadsFromDisk(t *testing.T) {
	dir := useJavOnlineRelatedDir(t)
	writeJavOnlineRelatedCache(t, dir, `{"entries":{"FORCE-001":{"site":"MissAV","items":[{"code":"FORCE-002"}]}}}`)
	if _, ok := lookupOnlineRelated("FORCE-001", false); !ok {
		t.Fatal("expected first read to succeed")
	}

	writeJavOnlineRelatedCache(t, dir, `{"entries":{"FORCE-001":{"site":"MissAV","items":[{"code":"FORCE-003"}]}}}`)
	entry, ok := lookupOnlineRelated("FORCE-001", true)
	if !ok {
		t.Fatal("expected forced read to succeed")
	}
	if len(entry.Items) != 1 || entry.Items[0].Code != "FORCE-003" {
		t.Fatalf("items = %+v, want the re-scraped FORCE-003 row", entry.Items)
	}
}
