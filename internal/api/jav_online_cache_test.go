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

	entry, ok := lookupOnlineRelated("ABC-123")
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

	if _, ok := lookupOnlineRelated("EMPTY-001"); ok {
		t.Fatal("entries without items must be ignored")
	}
	if _, ok := lookupOnlineRelated("MISSING-001"); ok {
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

	entry, ok := lookupOnlineRelated("pref-001")
	if !ok || len(entry.Items) != 2 {
		t.Fatalf("lookup returned %+v (ok=%v), want 2 items", entry, ok)
	}
	if entry.Items[1].Title != "推荐二" {
		t.Fatalf("item title = %q, want 推荐二", entry.Items[1].Title)
	}
}
