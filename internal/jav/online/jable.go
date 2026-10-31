package online

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"javboss/internal/util"
)

// ErrNotFound reports that the provider has no entry for the requested code.
var ErrNotFound = errors.New("online stream not found")

// ErrBlocked reports that the provider refused the lookup (Cloudflare challenge
// or an exhausted rate limit) instead of answering with a missing page.
var ErrBlocked = errors.New("online provider blocked the request")

const (
	jableProvider = "Jable"
	jableOrigin   = "https://jable.tv"
	requestUA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	cacheTTL      = 20 * time.Minute
	lookupTimeout = 45 * time.Second
	maxPageBytes  = 8 << 20
)

// Source describes a browser-playable online stream resolved for a JAV code.
type Source struct {
	Provider   string
	PageURL    string
	StreamURL  string
	StreamType string
}

var (
	hlsURLPattern    = regexp.MustCompile(`var\s+hlsUrl\s*=\s*'([^']+)'`)
	videoLinkPattern = regexp.MustCompile(`href="(?:https://jable\.tv)?(/videos/[a-z0-9\-]+/)"`)
	slugSeparator    = regexp.MustCompile(`[^a-z0-9]+`)

	pageClient = util.NewHTTPClient(25 * time.Second)

	cacheMu  sync.Mutex
	cacheMap = make(map[string]cachedSource)
)

type cachedSource struct {
	source  Source
	expires time.Time
}

// Resolve looks up the first available online stream for a JAV code.
func Resolve(ctx context.Context, code string) (Source, error) {
	slug := jableSlug(code)
	if slug == "" {
		return Source{}, ErrNotFound
	}
	if source, ok := loadCached(slug); ok {
		return source, nil
	}

	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()

	source, err := resolveJable(ctx, slug)
	if err != nil {
		return Source{}, err
	}
	storeCached(slug, source)
	return source, nil
}

// jableSlug converts a JAV code into the slug used by Jable video pages.
func jableSlug(code string) string {
	return strings.Trim(slugSeparator.ReplaceAllString(strings.ToLower(strings.TrimSpace(code)), "-"), "-")
}

func resolveJable(ctx context.Context, slug string) (Source, error) {
	pageURL := fmt.Sprintf("%s/videos/%s/", jableOrigin, slug)
	html, status, err := fetchPage(ctx, pageURL)
	if err != nil {
		return Source{}, err
	}
	if status == http.StatusOK {
		if source, ok := parseJablePage(html, pageURL); ok {
			return source, nil
		}
	}
	if isBlockedStatus(status) {
		return Source{}, ErrBlocked
	}

	// Some codes live under a different slug (subtitle or leaked variants),
	// so fall back to the provider's search page and open its first result.
	html, status, err = fetchPage(ctx, fmt.Sprintf("%s/search/%s/", jableOrigin, slug))
	if err != nil {
		return Source{}, err
	}
	if isBlockedStatus(status) {
		return Source{}, ErrBlocked
	}
	if status != http.StatusOK {
		return Source{}, ErrNotFound
	}
	pageURL = firstVideoLink(html)
	if pageURL == "" {
		return Source{}, ErrNotFound
	}
	html, status, err = fetchPage(ctx, pageURL)
	if err != nil {
		return Source{}, err
	}
	if isBlockedStatus(status) {
		return Source{}, ErrBlocked
	}
	if status != http.StatusOK {
		return Source{}, ErrNotFound
	}
	source, ok := parseJablePage(html, pageURL)
	if !ok {
		return Source{}, ErrNotFound
	}
	return source, nil
}

func parseJablePage(html, pageURL string) (Source, bool) {
	match := hlsURLPattern.FindStringSubmatch(html)
	if len(match) < 2 {
		return Source{}, false
	}
	stream := strings.TrimSpace(match[1])
	if !strings.HasPrefix(stream, "http://") && !strings.HasPrefix(stream, "https://") {
		return Source{}, false
	}
	return Source{
		Provider:   jableProvider,
		PageURL:    pageURL,
		StreamURL:  stream,
		StreamType: "hls",
	}, true
}

func firstVideoLink(html string) string {
	for _, match := range videoLinkPattern.FindAllStringSubmatch(html, 20) {
		if path := match[1]; path != "" {
			return jableOrigin + path
		}
	}
	return ""
}

// fetchPage prefers a native request and falls back to the platform curl binary,
// whose TLS stack is what Cloudflare-protected providers accept in practice.
func fetchPage(ctx context.Context, target string) (string, int, error) {
	body, status, nativeErr := nativeFetch(ctx, target)
	if nativeErr == nil && status == http.StatusOK && !isChallenge(body) {
		return body, status, nil
	}
	curlBody, curlStatus, curlErr := curlFetch(ctx, target)
	if curlErr != nil {
		if nativeErr != nil {
			return "", 0, nativeErr
		}
		return body, status, nil
	}
	if !isChallenge(curlBody) {
		return curlBody, curlStatus, nil
	}
	if nativeErr == nil && !isChallenge(body) {
		return body, status, nil
	}
	return curlBody, curlStatus, nil
}

func nativeFetch(ctx context.Context, target string) (string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", 0, err
	}
	setPageHeaders(req)
	resp, err := pageClient.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxPageBytes))
	if err != nil {
		return "", resp.StatusCode, err
	}
	return string(data), resp.StatusCode, nil
}

func curlFetch(ctx context.Context, target string) (string, int, error) {
	bin, err := exec.LookPath("curl")
	if err != nil {
		return "", 0, err
	}
	args := []string{
		"-sS", "-L", "--max-time", "25", "--compressed",
		"-A", requestUA,
		"-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
		"-H", "Sec-Fetch-Mode: navigate",
		"-H", "Sec-Fetch-Site: none",
		"-H", "Upgrade-Insecure-Requests: 1",
		"-w", "\n%{http_code}",
		target,
	}
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		return "", 0, err
	}
	text := string(out)
	index := strings.LastIndex(text, "\n")
	if index < 0 {
		return "", 0, errors.New("unexpected curl output")
	}
	status, err := strconv.Atoi(strings.TrimSpace(text[index+1:]))
	if err != nil {
		return "", 0, err
	}
	return text[:index], status, nil
}

func setPageHeaders(req *http.Request) {
	req.Header.Set("User-Agent", requestUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Site", "none")
	req.Header.Set("Upgrade-Insecure-Requests", "1")
}

func isChallenge(body string) bool {
	return strings.Contains(body, "Just a moment...") ||
		strings.Contains(body, "Attention Required!") ||
		strings.Contains(body, "cf-mitigated")
}

func isBlockedStatus(status int) bool {
	switch status {
	case http.StatusForbidden, http.StatusTooManyRequests, http.StatusServiceUnavailable:
		return true
	}
	return false
}

func loadCached(slug string) (Source, bool) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	entry, ok := cacheMap[slug]
	if !ok {
		return Source{}, false
	}
	if time.Now().After(entry.expires) {
		delete(cacheMap, slug)
		return Source{}, false
	}
	return entry.source, true
}

func storeCached(slug string, source Source) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cacheMap[slug] = cachedSource{source: source, expires: time.Now().Add(cacheTTL)}
}
