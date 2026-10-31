package db

import (
	"context"
	"reflect"
	"testing"

	"javboss/internal/models"
)

func TestListSimilarJavsScoresAndOrdersByRating(t *testing.T) {
	deps := newTestDependencies()
	gdb := openTestDB(deps, t)
	ctx := context.Background()

	studio := models.JavStudio{Name: "Similar Studio"}
	series := models.JavSeries{Name: "Similar Series"}
	idol := models.JavIdol{Name: "Similar Idol"}
	tag := models.JavTag{Name: "Similar Tag", IsUser: true}
	for name, value := range map[string]any{
		"studio": &studio,
		"series": &series,
		"idol":   &idol,
		"tag":    &tag,
	} {
		if err := gdb.Create(value).Error; err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
	}

	source := models.Jav{Code: "SIM-000", Title: "Source", StudioID: &studio.ID, SeriesID: &series.ID}
	if err := gdb.Create(&source).Error; err != nil {
		t.Fatalf("create source: %v", err)
	}
	if err := gdb.Create(&models.JavIdolMap{JavID: source.ID, JavIdolID: idol.ID}).Error; err != nil {
		t.Fatalf("create source idol map: %v", err)
	}
	if err := gdb.Create(&models.JavTagMap{JavID: source.ID, JavTagID: tag.ID}).Error; err != nil {
		t.Fatalf("create source tag map: %v", err)
	}

	type candidate struct {
		code     string
		zhTitle  string
		rating   float64
		favorite float64
		seriesID *int64
		studioID *int64
		idol     bool
		tag      bool
	}
	candidates := []candidate{
		{code: "SIM-003", zhTitle: "相似作品中文标题", rating: 4.5, seriesID: &series.ID, studioID: &studio.ID, idol: true, tag: true},
		{code: "SIM-002", rating: 2.0, seriesID: &series.ID, idol: true},
		{code: "SIM-001", rating: 4.0, idol: true},
		{code: "SIM-008", rating: 4.0, favorite: 5, idol: true},
		{code: "SIM-006", rating: 3.0, seriesID: &series.ID},
		{code: "SIM-005", rating: 4.8, studioID: &studio.ID},
		{code: "SIM-004", rating: 5.0, tag: true},
		{code: "SIM-007", rating: 5.0},
	}
	for _, item := range candidates {
		row := models.Jav{
			Code:           item.code,
			Title:          item.code + " Title",
			ZhTitle:        item.zhTitle,
			SeriesID:       item.seriesID,
			StudioID:       item.studioID,
			Rating:         item.rating,
			FavoriteRating: item.favorite,
		}
		if err := gdb.Create(&row).Error; err != nil {
			t.Fatalf("create candidate %s: %v", item.code, err)
		}
		if item.idol {
			if err := gdb.Create(&models.JavIdolMap{JavID: row.ID, JavIdolID: idol.ID}).Error; err != nil {
				t.Fatalf("create idol map for %s: %v", item.code, err)
			}
		}
		if item.tag {
			if err := gdb.Create(&models.JavTagMap{JavID: row.ID, JavTagID: tag.ID}).Error; err != nil {
				t.Fatalf("create tag map for %s: %v", item.code, err)
			}
		}
	}

	items, err := deps.store.ListSimilarJavs(ctx, source.ID, 5, true)
	if err != nil {
		t.Fatalf("list similar javs: %v", err)
	}
	wantCodes := []string{"SIM-003", "SIM-002", "SIM-008", "SIM-001", "SIM-006"}
	if len(items) != len(wantCodes) {
		t.Fatalf("similar count = %d, want %d (%#v)", len(items), len(wantCodes), items)
	}
	for index, want := range wantCodes {
		if items[index].Code != want {
			t.Fatalf("similar[%d] = %q, want %q (%#v)", index, items[index].Code, want, items)
		}
		if items[index].ID == source.ID {
			t.Fatalf("source item must not be returned")
		}
	}
	if items[0].Rating != 4.5 {
		t.Fatalf("unexpected rating for first item: %v", items[0].Rating)
	}
	if items[0].ZhTitle != "相似作品中文标题" {
		t.Fatalf("unexpected zh title for first item: %q", items[0].ZhTitle)
	}

	limited, err := deps.store.ListSimilarJavs(ctx, source.ID, 2, true)
	if err != nil {
		t.Fatalf("list limited similar javs: %v", err)
	}
	if got := []string{limited[0].Code, limited[1].Code}; !reflect.DeepEqual(got, []string{"SIM-003", "SIM-002"}) {
		t.Fatalf("limited codes = %v, want [SIM-003 SIM-002]", got)
	}

	var localCandidate models.Jav
	if err := gdb.Where("code = ?", "SIM-003").First(&localCandidate).Error; err != nil {
		t.Fatalf("load local candidate: %v", err)
	}
	directory := models.Directory{Path: t.TempDir()}
	video := models.Video{Fingerprint: "similar-local"}
	if err := gdb.Create(&directory).Error; err != nil {
		t.Fatalf("create directory: %v", err)
	}
	if err := gdb.Create(&video).Error; err != nil {
		t.Fatalf("create video: %v", err)
	}
	if err := gdb.Create(&models.VideoLocation{
		VideoID:      video.ID,
		DirectoryID:  directory.ID,
		RelativePath: "similar-local.mp4",
		Filename:     "similar-local.mp4",
		JavID:        &localCandidate.ID,
	}).Error; err != nil {
		t.Fatalf("create video location: %v", err)
	}
	withoutLocal, err := deps.store.ListSimilarJavs(ctx, source.ID, 5, false)
	if err != nil {
		t.Fatalf("list similar javs without local: %v", err)
	}
	if len(withoutLocal) == 0 || withoutLocal[0].Code != "SIM-002" {
		t.Fatalf("local item not excluded: %#v", withoutLocal)
	}
}

func TestListSimilarJavsReturnsEmptyWithoutRelations(t *testing.T) {
	deps := newTestDependencies()
	gdb := openTestDB(deps, t)
	ctx := context.Background()

	source := models.Jav{Code: "SIM-100", Title: "Unrelated"}
	other := models.Jav{Code: "SIM-101", Title: "Other"}
	for _, row := range []*models.Jav{&source, &other} {
		if err := gdb.Create(row).Error; err != nil {
			t.Fatalf("create jav %s: %v", row.Code, err)
		}
	}

	items, err := deps.store.ListSimilarJavs(ctx, source.ID, 5, true)
	if err != nil {
		t.Fatalf("list similar javs: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("similar items = %#v, want none", items)
	}
}
