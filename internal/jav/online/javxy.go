package online

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"javboss/internal/util"
)

const (
	javxyWorkerBase = "https://worker.javxy.cc.cd"
	javxyClientID   = "laosiji-new"
	javxyCacheTTL   = 20 * time.Minute
	javxyTimeout    = 20 * time.Second
	javxyMaxBytes   = 1 << 20
)

var (
	// The worker lists the same sample qualities the JavBoss userscript
	// exposes; order them from best to worst.
	javxyQualityOrder = []string{
		"4k", "hhb", "1080p", "hmb", "720p", "mhb", "540p", "mmb", "480p", "396p", "360p", "240p",
	}

	javxyClient = util.NewHTTPClient(javxyTimeout)

	javxyCacheMu sync.Mutex
	javxyCache   = make(map[string]cachedSource)
)

type javxyResponse struct {
	Quality   string            `json:"quality"`
	Qualities map[string]string `json:"qualities"`
	Trailer   string            `json:"trailer"`
	Source    string            `json:"source"`
	Type      string            `json:"type"`
	Urls      []string          `json:"urls"`
}

// resolveJavxy asks the public JavBoss userscript worker for a playable sample
// stream. The worker is reachable without browser verification, unlike the
// provider pages themselves.
func resolveJavxy(ctx context.Context, code string) (Source, error) {
	key := strings.ToUpper(strings.TrimSpace(code))
	if key == "" {
		return Source{}, ErrNotFound
	}
	if source, ok := loadJavxyCached(key); ok {
		return source, nil
	}

	ctx, cancel := context.WithTimeout(ctx, javxyTimeout)
	defer cancel()

	target := fmt.Sprintf(
		"%s/api/trailers/%s?client=%s",
		javxyWorkerBase,
		url.PathEscape(key),
		javxyClientID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return Source{}, err
	}
	req.Header.Set("Accept", "application/json,text/plain,*/*")
	req.Header.Set("User-Agent", requestUA)

	resp, err := javxyClient.Do(req)
	if err != nil {
		return Source{}, err
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusTooManyRequests,
		resp.StatusCode == http.StatusForbidden,
		resp.StatusCode == http.StatusUnauthorized:
		return Source{}, ErrBlocked
	case resp.StatusCode != http.StatusOK:
		return Source{}, ErrNotFound
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, javxyMaxBytes))
	if err != nil {
		return Source{}, err
	}
	var payload javxyResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return Source{}, ErrNotFound
	}
	stream := pickJavxyStream(payload)
	if stream == "" {
		return Source{}, ErrNotFound
	}

	provider := "Javxy"
	if name := strings.TrimSpace(payload.Source); name != "" {
		provider = "Javxy · " + name
	}
	source := Source{
		Provider:   provider,
		PageURL:    "https://javxy.cc.cd/",
		StreamURL:  stream,
		StreamType: streamTypeOf(stream),
		Kind:       "trailer",
	}
	storeJavxyCached(key, source)
	return source, nil
}

func pickJavxyStream(payload javxyResponse) string {
	for _, quality := range javxyQualityOrder {
		if stream := validStreamURL(payload.Qualities[quality]); stream != "" {
			return stream
		}
	}
	if stream := validStreamURL(payload.Trailer); stream != "" {
		return stream
	}
	for _, stream := range payload.Urls {
		if valid := validStreamURL(stream); valid != "" {
			return valid
		}
	}
	for _, stream := range payload.Qualities {
		if valid := validStreamURL(stream); valid != "" {
			return valid
		}
	}
	return ""
}

func validStreamURL(value string) string {
	stream := strings.TrimSpace(value)
	if !strings.HasPrefix(stream, "http://") && !strings.HasPrefix(stream, "https://") {
		return ""
	}
	return stream
}

func streamTypeOf(stream string) string {
	if strings.Contains(strings.ToLower(stream), ".m3u8") {
		return "hls"
	}
	return "direct"
}

func loadJavxyCached(key string) (Source, bool) {
	javxyCacheMu.Lock()
	defer javxyCacheMu.Unlock()
	entry, ok := javxyCache[key]
	if !ok {
		return Source{}, false
	}
	if time.Now().After(entry.expires) {
		delete(javxyCache, key)
		return Source{}, false
	}
	return entry.source, true
}

func storeJavxyCached(key string, source Source) {
	javxyCacheMu.Lock()
	defer javxyCacheMu.Unlock()
	javxyCache[key] = cachedSource{source: source, expires: time.Now().Add(javxyCacheTTL)}
}
