package enrichment

import (
	"context"
	"errors"
	"strings"
	"time"

	"javboss/internal/common/logging"
	"javboss/internal/db"
	"javboss/internal/jav/scrape"
)

const javRatingBatchSize = 10

// StartJavRatingEnrichment periodically backfills missing JavDB ratings.
func StartJavRatingEnrichment(ctx context.Context, interval time.Duration) {
	startPeriodicJob(ctx, interval, "jav rating", EnrichJavRatings)
}

// EnrichJavRatings fills the provider rating for a small batch of JAV rows.
func EnrichJavRatings(ctx context.Context) error {
	items, err := db.Default().ListJavMissingRating(ctx, javRatingBatchSize)
	if err != nil {
		return err
	}
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return err
		}
		code := strings.TrimSpace(item.Code)
		if code == "" {
			continue
		}
		info, err := scrape.LookupJavByCode(ctx, code, scrape.ProviderJavDB)
		if err != nil {
			if !errors.Is(err, scrape.ErrNotFound) {
				logging.Error("lookup jav rating failed code=%s err=%v", code, err)
			}
			continue
		}
		if info == nil || info.Rating <= 0 {
			continue
		}
		if err := db.Default().UpdateJavRating(ctx, item.ID, info.Rating); err != nil {
			logging.Error("update jav rating failed code=%s err=%v", code, err)
			continue
		}
		logging.Info("jav rating updated code=%s rating=%.2f", code, info.Rating)
	}
	return nil
}
