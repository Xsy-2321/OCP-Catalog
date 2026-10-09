// Command example-catalog-go is a minimal, spec-valid OCP Catalog Node.
//
// It serves five endpoints from ~3 in-memory products using only the Go
// standard library — no database, no vendor client, no auth:
//
//	GET  /.well-known/ocp-catalog   discovery
//	GET  /ocp/manifest              capabilities
//	GET  /ocp/health                liveness
//	GET  /ocp/contracts             object contracts (empty -- read-only node)
//	POST /ocp/query                 keyword search over products
//	POST /ocp/resolve               resolve one entry into actions
//
// Response shapes match @ocp-catalog/ocp-schema; main_test.go asserts the
// required OCP fields on every endpoint.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type product struct {
	ID           string
	Title        string
	Summary      string
	Brand        string
	Category     string
	Currency     string
	Amount       float64
	Availability string
	URL          string
	UpdatedAt    string
}

var products = []product{
	{"sku-001", "Aurora Wireless Headphones", "Over-ear Bluetooth headphones with active noise cancellation.", "Aurora", "electronics", "USD", 199.0, "in_stock", "https://example.com/products/aurora-headphones", "2026-07-01T00:00:00.000Z"},
	{"sku-002", "Trailhead Running Shoes", "Lightweight trail runners with a grippy all-terrain outsole.", "Trailhead", "footwear", "USD", 129.0, "low_stock", "https://example.com/products/trailhead-shoes", "2026-07-02T00:00:00.000Z"},
	{"sku-003", "Camp Kettle 1.5L", "Hard-anodized aluminium kettle for backcountry cooking.", "Basecamp", "outdoors", "USD", 39.0, "in_stock", "https://example.com/products/camp-kettle", "2026-07-03T00:00:00.000Z"},
}

const providerID = "example_inmemory"
const queryPack = "ocp.query.keyword.v1"
const queryMode = "keyword"

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var (
	catalogID   = env("CATALOG_ID", "cat_example_go")
	catalogName = env("CATALOG_NAME", "Example Go Catalog")
	port        = env("PORT", "4402")
	baseURL     = strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:"+env("PORT", "4402")), "/")
)

func randID(prefix string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func entryID(p product) string { return fmt.Sprintf("entry_%s_%s", providerID, p.ID) }

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

type obj = map[string]any

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func wellKnownDiscovery() obj {
	return obj{
		"ocp_version":   "1.0",
		"kind":          "WellKnownCatalogDiscovery",
		"catalog_id":    catalogID,
		"catalog_name":  catalogName,
		"manifest_url":  baseURL + "/ocp/manifest",
		"health_url":    baseURL + "/ocp/health",
		"query_url":     baseURL + "/ocp/query",
		"resolve_url":   baseURL + "/ocp/resolve",
		"contracts_url": baseURL + "/ocp/contracts",
	}
}

func manifest() obj {
	return obj{
		"ocp_version":         "1.0",
		"kind":                "CatalogManifest",
		"id":                  "manifest_" + catalogID,
		"catalog_id":          catalogID,
		"catalog_name":        catalogName,
		"description":         "Minimal in-memory OCP Catalog Node example (Go).",
		"registry_visibility": "public",
		"endpoints": obj{
			"health":    obj{"url": baseURL + "/ocp/health", "method": "GET"},
			"query":     obj{"url": baseURL + "/ocp/query", "method": "POST"},
			"resolve":   obj{"url": baseURL + "/ocp/resolve", "method": "POST"},
			"contracts": obj{"url": baseURL + "/ocp/contracts", "method": "GET"},
		},
		"query_capabilities": []obj{
			{
				"capability_id": "ocp.example.product.search.v1",
				"name":          "Keyword product search",
				"description":   "Case-insensitive keyword match over the in-memory product list.",
				"query_packs": []obj{
					{
						"pack_id":     queryPack,
						"description": "Keyword search over title, summary, brand, and category.",
						"query_modes": []string{queryMode},
					},
				},
				"supports_explain": true,
				"supports_resolve": true,
			},
		},
		// Required by the schema even for a read-only node that ingests nothing.
		"object_contracts": []obj{},
	}
}

func health() obj {
	return obj{
		"ocp_version": "1.0",
		"kind":        "CatalogHealth",
		"catalog_id":  catalogID,
		"status":      "healthy",
		"ready":       true,
		"checked_at":  nowISO(),
	}
}

func contracts() obj {
	return obj{
		"ocp_version":      "1.0",
		"kind":             "ObjectContractList",
		"catalog_id":       catalogID,
		"object_contracts": []obj{},
		"note":             "Read-only example node; it does not accept provider object ingestion.",
	}
}

func toEntry(p product) obj {
	return obj{
		"kind":        "CatalogEntry",
		"catalog_id":  catalogID,
		"entry_id":    entryID(p),
		"provider_id": providerID,
		"object_id":   p.ID,
		"object_type": "ocp.commerce.product",
		"title":       p.Title,
		"summary":     p.Summary,
		"attributes": obj{
			"brand":       p.Brand,
			"category":    p.Category,
			"price":       obj{"currency": p.Currency, "amount": p.Amount},
			"inventory":   obj{"availability_status": p.Availability},
			"product_url": p.URL,
		},
	}
}

func invalidRequest(message string) (int, obj) {
	return http.StatusBadRequest, obj{"error": obj{"code": "invalid_request", "message": message}}
}

func validateQuery(body obj) error {
	allowed := map[string]bool{"ocp_version": true, "kind": true, "catalog_id": true, "query_pack": true,
		"query_mode": true, "query": true, "filters": true, "limit": true, "offset": true, "cursor": true, "explain": true}
	for key, value := range body {
		if !allowed[key] {
			return fmt.Errorf("invalid catalog query request")
		}
		switch key {
		case "ocp_version", "kind", "query_mode":
			text, ok := value.(string)
			if !ok || (key == "ocp_version" && text != "1.0") || (key == "kind" && text != "CatalogQueryRequest") ||
				(key == "query_mode" && text != "keyword" && text != "filter" && text != "semantic" && text != "hybrid") {
				return fmt.Errorf("invalid catalog query request")
			}
		case "catalog_id", "query_pack", "cursor", "query":
			text, ok := value.(string)
			if !ok || (key != "query" && text == "") || (key == "query" && utf8.RuneCountInString(text) > 500) ||
				(key == "cursor" && utf8.RuneCountInString(text) > 512) {
				return fmt.Errorf("invalid catalog query request")
			}
		case "limit":
			number, ok := value.(float64)
			if !ok || number < 1 || number > 50 || math.Trunc(number) != number {
				return fmt.Errorf("limit must be an integer between 1 and 50")
			}
		case "offset":
			if number, ok := value.(float64); !ok || number != 0 {
				return fmt.Errorf("offset must be zero; use cursor pagination")
			}
		case "explain":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("explain must be a boolean")
			}
		case "filters":
			filters, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf("invalid catalog query filters")
			}
			for field, filter := range filters {
				switch field {
				case "category", "brand", "currency", "availability_status", "provider_id", "sku":
					if text, ok := filter.(string); !ok || text == "" {
						return fmt.Errorf("invalid catalog query filters")
					}
				case "min_amount", "max_amount":
					if number, ok := filter.(float64); !ok || number < 0 || math.IsNaN(number) || math.IsInf(number, 0) {
						return fmt.Errorf("invalid catalog query filters")
					}
				case "in_stock_only", "has_image":
					if _, ok := filter.(bool); !ok {
						return fmt.Errorf("invalid catalog query filters")
					}
				default:
					return fmt.Errorf("invalid catalog query filters")
				}
			}
		}
	}
	return nil
}

// validateQueryCapability checks manifest support after protocol shape validation.
func validateQueryCapability(body obj) error {
	if pack, exists := body["query_pack"]; exists && pack != queryPack {
		return fmt.Errorf("unsupported query_pack: only %s is supported", queryPack)
	}
	// Preserve the example's keyword/list-all default when mode is omitted.
	if mode, exists := body["query_mode"]; exists && mode != queryMode {
		return fmt.Errorf("unsupported query_mode: only %s is supported", queryMode)
	}
	if filters, ok := body["filters"].(map[string]any); ok && len(filters) > 0 {
		return fmt.Errorf("unsupported filters: this keyword node does not support filter fields")
	}
	return nil
}

func query(body obj) (int, obj) {
	if err := validateQuery(body); err != nil {
		return invalidRequest(err.Error())
	}
	if err := validateQueryCapability(body); err != nil {
		return invalidRequest(err.Error())
	}
	cursor := "0"
	if raw, exists := body["cursor"]; exists {
		var ok bool
		cursor, ok = raw.(string)
		if !ok {
			return invalidRequest("cursor must be a non-negative decimal integer string")
		}
	}
	offsetValue, err := strconv.ParseUint(cursor, 10, 53)
	if err != nil || cursor == "" || strings.IndexFunc(cursor, func(r rune) bool { return r < '0' || r > '9' }) != -1 {
		return invalidRequest("cursor must be a non-negative decimal integer string")
	}
	term := strings.ToLower(strings.TrimSpace(asString(body["query"])))
	limit := 20
	if l, ok := body["limit"].(float64); ok && l >= 1 && l <= 50 {
		limit = int(l)
	}
	var matches []product
	for _, p := range products {
		if term == "" || strings.Contains(strings.ToLower(p.Title+" "+p.Summary+" "+p.Brand+" "+p.Category), term) {
			matches = append(matches, p)
		}
	}
	offset := len(matches)
	if offsetValue < uint64(len(matches)) {
		offset = int(offsetValue)
	}
	end := offset + limit
	if end > len(matches) {
		end = len(matches)
	}
	hasMore := end < len(matches)
	page := obj{"limit": limit, "offset": 0, "has_more": hasMore}
	if hasMore {
		page["next_cursor"] = strconv.Itoa(end)
	}
	matches = matches[offset:end]
	entries := make([]obj, 0, len(matches))
	for _, p := range matches {
		entries = append(entries, obj{
			"entry":   toEntry(p),
			"score":   1,
			"explain": []string{fmt.Sprintf("Keyword match for %q.", asString(body["query"]))},
		})
	}
	return http.StatusOK, obj{
		"ocp_version":  "1.0",
		"kind":         "CatalogQueryResult",
		"id":           randID("qry"),
		"catalog_id":   catalogID,
		"query_pack":   queryPack,
		"query_mode":   queryMode,
		"query":        asString(body["query"]),
		"result_count": len(entries),
		"page":         page,
		"entries":      entries,
	}
}

func resolve(body obj) (int, obj) {
	id := asString(body["entry_id"])
	for _, p := range products {
		if entryID(p) == id {
			now := nowISO()
			return http.StatusOK, obj{
				"ocp_version":          "1.0",
				"kind":                 "ResolvableReference",
				"id":                   randID("res"),
				"catalog_id":           catalogID,
				"entry_id":             entryID(p),
				"commercial_object_id": "co_" + p.ID,
				"object_id":            p.ID,
				"object_type":          "ocp.commerce.product",
				"provider_id":          providerID,
				"title":                p.Title,
				"visible_attributes": obj{
					"brand":        p.Brand,
					"category":     p.Category,
					"price":        obj{"currency": p.Currency, "amount": p.Amount},
					"availability": p.Availability,
				},
				"action_bindings": []obj{
					{
						"action_id":   "view",
						"action_type": "url",
						"label":       "View product",
						"entrypoint":  obj{"url": p.URL, "method": "GET"},
					},
				},
				"freshness":  obj{"object_updated_at": p.UpdatedAt, "resolved_at": now},
				"expires_at": time.Now().UTC().Add(time.Hour).Format("2006-01-02T15:04:05.000Z"),
			}
		}
	}
	if id == "" {
		id = "(missing)"
	}
	return http.StatusNotFound, obj{"error": obj{"code": "not_found", "message": "Unknown entry_id: " + id}}
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func readJSON(r *http.Request) (obj, error) {
	var parsed obj
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&parsed); err != nil || parsed == nil {
		return nil, fmt.Errorf("request body must be a valid JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("request body must contain exactly one JSON object")
	}
	return parsed, nil
}

// NewMux builds the router. Exported so tests can exercise it without a socket.
func NewMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/ocp-catalog", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, wellKnownDiscovery()) })
	mux.HandleFunc("GET /ocp/manifest", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, manifest()) })
	mux.HandleFunc("GET /ocp/health", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, health()) })
	mux.HandleFunc("GET /ocp/contracts", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, contracts()) })
	mux.HandleFunc("POST /ocp/query", func(w http.ResponseWriter, r *http.Request) {
		input, err := readJSON(r)
		if err != nil {
			status, body := invalidRequest(err.Error())
			writeJSON(w, status, body)
			return
		}
		status, body := query(input)
		writeJSON(w, status, body)
	})
	mux.HandleFunc("POST /ocp/resolve", func(w http.ResponseWriter, r *http.Request) {
		input, err := readJSON(r)
		if err != nil {
			status, body := invalidRequest(err.Error())
			writeJSON(w, status, body)
			return
		}
		status, body := resolve(input)
		writeJSON(w, status, body)
	})
	return mux
}

func main() {
	addr := ":" + port
	log.Printf("Example Go OCP Catalog Node listening on %s", baseURL)
	if err := http.ListenAndServe(addr, NewMux()); err != nil {
		log.Fatal(err)
	}
}
