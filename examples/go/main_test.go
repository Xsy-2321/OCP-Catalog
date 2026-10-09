package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

type queryExample struct {
	Name         string          `json:"name"`
	Body         json.RawMessage `json:"body"`
	RawBody      *string         `json:"raw_body"`
	Status       int             `json:"status"`
	ResultCount  int             `json:"result_count"`
	PageLimit    int             `json:"page_limit"`
	EntryIDs     []string        `json:"entry_ids"`
	SchemaValid  bool            `json:"schema_valid"`
	ErrorMessage string          `json:"error_message"`
}

type queryFixture struct {
	Cases          []queryExample `json:"cases"`
	NodeCapability struct {
		QueryPack    string   `json:"query_pack"`
		QueryModes   []string `json:"query_modes"`
		FilterFields []string `json:"filter_fields"`
	} `json:"node_capability"`
}

func loadQueryFixture(t *testing.T, name string) queryFixture {
	t.Helper()
	data, err := os.ReadFile("../../fixtures/query-conformance/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var fixture queryFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestSharedQueryConformance(t *testing.T) {
	runQueryCases(t, loadQueryFixture(t, "cases.json"), false)
}

func TestSharedQueryCapabilitySemantics(t *testing.T) {
	fixture := loadQueryFixture(t, "semantics.json")
	srv := httptest.NewServer(NewMux())
	defer srv.Close()
	_, body := do(t, srv, "GET", "/ocp/manifest", "")
	type declaredPack struct {
		ID    string
		Modes []string
	}
	packs := []declaredPack{}
	filterFields := []string{}
	for _, rawCapability := range body["query_capabilities"].([]any) {
		capability := rawCapability.(map[string]any)
		for _, rawPack := range capability["query_packs"].([]any) {
			pack := rawPack.(map[string]any)
			modes := []string{}
			for _, mode := range pack["query_modes"].([]any) {
				modes = append(modes, mode.(string))
			}
			packs = append(packs, declaredPack{pack["pack_id"].(string), modes})
		}
		if fields, ok := capability["input_fields"].([]any); ok {
			for _, field := range fields {
				name := field.(map[string]any)["name"].(string)
				if strings.HasPrefix(name, "filters.") {
					filterFields = append(filterFields, strings.TrimPrefix(name, "filters."))
				}
			}
		}
	}
	if !reflect.DeepEqual(packs, []declaredPack{{fixture.NodeCapability.QueryPack, fixture.NodeCapability.QueryModes}}) ||
		!reflect.DeepEqual(filterFields, fixture.NodeCapability.FilterFields) {
		t.Fatalf("manifest capability differs from matrix: packs=%v filters=%v", packs, filterFields)
	}
	runQueryCases(t, fixture, true)
}

func runQueryCases(t *testing.T, fixture queryFixture, schemaValid bool) {
	t.Helper()
	srv := httptest.NewServer(NewMux())
	defer srv.Close()
	for _, example := range fixture.Cases {
		t.Run(example.Name, func(t *testing.T) {
			raw := string(example.Body)
			if example.RawBody != nil {
				raw = *example.RawBody
			}
			if schemaValid || example.SchemaValid {
				var input obj
				if err := json.Unmarshal([]byte(raw), &input); err != nil {
					t.Fatal(err)
				}
				// Capability rejection must follow successful protocol shape validation.
				if err := validateQuery(input); err != nil {
					t.Fatalf("semantic fixture has invalid shape: %v", err)
				}
			}
			status, result := do(t, srv, "POST", "/ocp/query", raw)
			if status != example.Status {
				t.Fatalf("status=%d want=%d body=%v", status, example.Status, result)
			}
			if status == 400 {
				envelope, ok := result["error"].(map[string]any)
				if !ok || envelope["code"] != "invalid_request" || asString(envelope["message"]) == "" {
					t.Fatalf("invalid error envelope: %v", result)
				}
				if example.ErrorMessage != "" && envelope["message"] != example.ErrorMessage {
					t.Fatalf("message=%v want=%s", envelope["message"], example.ErrorMessage)
				}
				return
			}
			hasKeys(t, result, "ocp_version", "kind", "id", "catalog_id", "query", "result_count", "page", "entries")
			if _, ok := result["query"].(string); !ok {
				t.Fatal("query must be a string")
			}
			if result["query_pack"] != "ocp.query.keyword.v1" || result["query_mode"] != "keyword" {
				t.Fatalf("invalid selected capability: %v", result)
			}
			page := result["page"].(map[string]any)
			if result["result_count"] != float64(example.ResultCount) || page["limit"] != float64(example.PageLimit) || page["offset"] != float64(0) {
				t.Fatalf("invalid result page: %v", result)
			}
			if example.EntryIDs != nil {
				entries := result["entries"].([]any)
				if len(entries) != len(example.EntryIDs) {
					t.Fatalf("entry count=%d want=%d", len(entries), len(example.EntryIDs))
				}
				for index, id := range example.EntryIDs {
					if entries[index].(map[string]any)["entry"].(map[string]any)["entry_id"] != id {
						t.Fatalf("wrong entry at %d: %v", index, entries[index])
					}
				}
			}
		})
	}
}

func TestCursorPagination(t *testing.T) {
	srv := httptest.NewServer(NewMux())
	defer srv.Close()
	ids := map[string]bool{}
	cursor := "0"
	for pageNumber := 0; pageNumber < 3; pageNumber++ {
		status, body := do(t, srv, "POST", "/ocp/query", fmt.Sprintf(`{"limit":1,"cursor":%q}`, cursor))
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		entries := body["entries"].([]any)
		if len(entries) != 1 {
			t.Fatalf("got %d entries", len(entries))
		}
		id := entries[0].(map[string]any)["entry"].(map[string]any)["entry_id"].(string)
		if ids[id] {
			t.Fatalf("repeated entry %s", id)
		}
		ids[id] = true
		page := body["page"].(map[string]any)
		if page["offset"] != float64(0) || page["has_more"] != (pageNumber < 2) {
			t.Fatalf("invalid page: %v", page)
		}
		cursor, _ = page["next_cursor"].(string)
	}
	if len(ids) != 3 || cursor != "" {
		t.Fatalf("pagination did not finish: ids=%v cursor=%q", ids, cursor)
	}
	_, end := do(t, srv, "POST", "/ocp/query", `{"limit":1,"cursor":"999"}`)
	if len(end["entries"].([]any)) != 0 || end["page"].(map[string]any)["has_more"] != false {
		t.Fatalf("invalid final page: %v", end)
	}
}

func TestInvalidCursors(t *testing.T) {
	srv := httptest.NewServer(NewMux())
	defer srv.Close()
	for _, cursor := range []string{`"-1"`, `"1.5"`, `"wrong"`, `"9007199254740992"`, `null`, `1`} {
		status, body := do(t, srv, "POST", "/ocp/query", `{"limit":1,"cursor":`+cursor+`}`)
		if status != 400 || body["error"].(map[string]any)["code"] != "invalid_request" {
			t.Fatalf("cursor %s: status=%d body=%v", cursor, status, body)
		}
	}
}

func do(t *testing.T, srv *httptest.Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest(method, srv.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("content-type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var parsed map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&parsed)
	return resp.StatusCode, parsed
}

func hasKeys(t *testing.T, body map[string]any, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if _, ok := body[k]; !ok {
			t.Errorf("missing required key %q", k)
		}
	}
}

func TestConformance(t *testing.T) {
	srv := httptest.NewServer(NewMux())
	defer srv.Close()

	t.Run("manifest", func(t *testing.T) {
		status, body := do(t, srv, "GET", "/ocp/manifest", "")
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		hasKeys(t, body, "ocp_version", "kind", "id", "catalog_id", "catalog_name", "endpoints", "query_capabilities", "object_contracts")
		if caps, ok := body["query_capabilities"].([]any); !ok || len(caps) == 0 {
			t.Error("query_capabilities must be non-empty")
		}
	})

	t.Run("health", func(t *testing.T) {
		status, body := do(t, srv, "GET", "/ocp/health", "")
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		hasKeys(t, body, "ocp_version", "kind", "catalog_id", "status", "ready", "checked_at")
		if body["ready"] != true {
			t.Error("ready must be true")
		}
	})

	t.Run("discovery", func(t *testing.T) {
		status, body := do(t, srv, "GET", "/.well-known/ocp-catalog", "")
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		if !strings.Contains(body["query_url"].(string), "/ocp/query") {
			t.Error("query_url must point at /ocp/query")
		}
	})

	t.Run("query keyword", func(t *testing.T) {
		status, body := do(t, srv, "POST", "/ocp/query", `{"query":"headphones"}`)
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		hasKeys(t, body, "ocp_version", "kind", "id", "catalog_id", "query", "result_count", "page", "entries")
		if body["result_count"].(float64) != 1 {
			t.Errorf("result_count = %v, want 1", body["result_count"])
		}
	})

	t.Run("query empty returns all", func(t *testing.T) {
		_, body := do(t, srv, "POST", "/ocp/query", `{}`)
		if body["result_count"].(float64) != 3 {
			t.Errorf("result_count = %v, want 3", body["result_count"])
		}
	})

	t.Run("resolve", func(t *testing.T) {
		status, body := do(t, srv, "POST", "/ocp/resolve", `{"entry_id":"entry_example_inmemory_sku-001"}`)
		if status != 200 {
			t.Fatalf("status = %d", status)
		}
		hasKeys(t, body, "ocp_version", "kind", "id", "catalog_id", "entry_id", "commercial_object_id", "object_id", "object_type", "provider_id", "title", "visible_attributes", "action_bindings", "freshness", "expires_at")
	})

	t.Run("resolve unknown 404", func(t *testing.T) {
		status, _ := do(t, srv, "POST", "/ocp/resolve", `{"entry_id":"entry_example_inmemory_nope"}`)
		if status != 404 {
			t.Errorf("status = %d, want 404", status)
		}
	})
}
