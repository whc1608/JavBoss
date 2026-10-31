package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"javboss/internal/common/logging"
	dbpkg "javboss/internal/db"
	"javboss/internal/jav/online"
)

// getJavOnlineStream resolves a network stream for a JAV item so the browser
// player can play titles that have no local file.
func getJavOnlineStream(c *gin.Context) {
	id, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || id <= 0 {
		respondLocalizedError(c, http.StatusBadRequest, "JAV ID 无效", "Invalid JAV ID")
		return
	}

	item, err := dbpkg.Default().GetJav(c.Request.Context(), id, nil)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respondLocalizedError(c, http.StatusNotFound, "JAV 不存在", "JAV does not exist")
			return
		}
		logging.Error("load jav for online stream error: %v", err)
		respondLocalizedError(c, http.StatusInternalServerError, "加载 JAV 信息失败", "Failed to load JAV information")
		return
	}
	code := strings.TrimSpace(item.Code)
	if code == "" {
		respondLocalizedError(c, http.StatusNotFound, "该条目缺少番号，无法匹配在线片源", "This item has no code, so no online stream can be matched")
		return
	}

	source, err := online.Resolve(c.Request.Context(), code)
	if err != nil {
		switch {
		case errors.Is(err, online.ErrNotFound):
			respondLocalizedError(c, http.StatusNotFound, "未找到可用的在线片源", "No online stream was found")
		case errors.Is(err, online.ErrBlocked):
			respondLocalizedError(c, http.StatusBadGateway, "在线片源站点拒绝了请求，请检查网络或代理设置", "The online provider refused the request; check the network or proxy settings")
		default:
			logging.Error("resolve online stream error: %v", err)
			respondLocalizedError(c, http.StatusBadGateway, "在线片源解析失败，请检查网络或代理设置", "Failed to resolve the online stream; check the network or proxy settings")
		}
		return
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"code":        code,
		"provider":    source.Provider,
		"page_url":    source.PageURL,
		"stream_url":  source.StreamURL,
		"stream_type": source.StreamType,
	})
}
