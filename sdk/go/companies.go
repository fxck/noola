package noola

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"
)

// CompanyInput is one of your clients as a SNAPSHOT, keyed by your stable id (never by name — two
// clients may share one).
//
// Members and Projects are whole-list replacements with a deliberate nil / empty distinction:
//   - nil            → leave what Noola has unchanged (e.g. a spend-only update)
//   - empty, non-nil → remove all of them
//   - non-empty      → exactly this list (synced members missing from it are unlinked; projects
//     missing from it are deleted). Members added by hand in Noola are never touched.
type CompanyInput struct {
	ExternalID string
	// Name; "" leaves it unchanged (a new company without a name is named after its external id).
	Name string
	// AvgMonthlySpend; nil leaves it unchanged.
	AvgMonthlySpend *float64
	// Currency, ISO 4217 (e.g. "EUR"); "" leaves it unchanged.
	Currency string
	Members  []Member
	Projects []Project
}

// Member links a person (by their external id — upsert the person first) to the client.
type Member struct {
	ExternalID string `json:"external_id"`
	// Role, e.g. "owner", "admin", "developer" — filterable in Noola audiences.
	Role string `json:"role,omitempty"`
}

// Project is one of the client's projects with its FULL service list.
type Project struct {
	ExternalID      string   `json:"external_id"`
	Name            string   `json:"name,omitempty"`
	Status          string   `json:"status,omitempty"`
	AvgMonthlySpend *float64 `json:"avg_monthly_spend,omitempty"`
	// Services replace the project's previous list on every sync (nil = none).
	Services []Service `json:"services"`
}

// Service is one service of a project. Type is the RESOLVED service type exactly as the platform has
// it — "ubuntu/nodejs@22", "postgresql:ha@16", "php-nginx@8.4+1.22", "object-storage" — Noola
// derives technology, version, OS and HA mode from it (send the deployed version, not "@latest").
type Service struct {
	Type       string `json:"type"`
	Hostname   string `json:"hostname,omitempty"`
	ExternalID string `json:"external_id,omitempty"`
}

// MarshalJSON keeps the nil (omit → unchanged) vs empty (send [] → clear) distinction that plain
// `omitempty` would lose.
func (c CompanyInput) MarshalJSON() ([]byte, error) {
	m := map[string]any{"external_id": c.ExternalID}
	if c.Name != "" {
		m["name"] = c.Name
	}
	if c.AvgMonthlySpend != nil {
		m["avg_monthly_spend"] = *c.AvgMonthlySpend
	}
	if c.Currency != "" {
		m["currency"] = c.Currency
	}
	if c.Members != nil {
		m["members"] = c.Members
	}
	if c.Projects != nil {
		projects := make([]Project, len(c.Projects))
		for i, p := range c.Projects {
			if p.Services == nil {
				p.Services = []Service{}
			}
			projects[i] = p
		}
		m["projects"] = projects
	}
	return json.Marshal(m)
}

// Company is a client as Noola holds it.
type Company struct {
	ID              string   `json:"id"`
	ExternalID      string   `json:"external_id"`
	Name            string   `json:"name"`
	AvgMonthlySpend *float64 `json:"avg_monthly_spend"`
	Currency        *string  `json:"currency"`
	// AccountStatus: "customer" (synced, live), "former" (removed in your system), "other".
	AccountStatus string           `json:"account_status"`
	SyncedAt      *time.Time       `json:"synced_at"`
	SyncRemovedAt *time.Time       `json:"sync_removed_at"`
	Members       []CompanyMember  `json:"members"`
	Projects      []CompanyProject `json:"projects"`
}

// CompanyMember is a member as stored (Source "sync" = from the API, "manual" = linked by an agent).
type CompanyMember struct {
	ExternalID *string `json:"external_id"`
	Email      *string `json:"email"`
	Name       string  `json:"name"`
	Role       string  `json:"role"`
	Source     string  `json:"source"`
}

// CompanyProject is a project as stored, with its parsed services.
type CompanyProject struct {
	ExternalID      string          `json:"external_id"`
	Name            string          `json:"name"`
	Status          string          `json:"status"`
	AvgMonthlySpend *float64        `json:"avg_monthly_spend"`
	Services        []StoredService `json:"services"`
}

// StoredService is a service with what Noola parsed from its type.
type StoredService struct {
	Type       string `json:"type"`
	Hostname   string `json:"hostname"`
	Technology string `json:"technology"`
	Version    string `json:"version"`
	OS         string `json:"os"`
	Mode       string `json:"mode"`
}

// UpsertCompanyResult is the outcome of UpsertCompany.
type UpsertCompanyResult struct {
	Company Company `json:"company"`
	Created bool    `json:"created"`
	// UnknownMembers are member external ids that matched no person — upsert them first.
	UnknownMembers []string `json:"unknown_members"`
}

// UpsertCompany applies one client snapshot.
func (c *Client) UpsertCompany(ctx context.Context, in CompanyInput) (*UpsertCompanyResult, error) {
	if in.ExternalID == "" {
		return nil, errors.New("noola: CompanyInput.ExternalID is required")
	}
	var out UpsertCompanyResult
	if err := c.do(ctx, "POST", "/v1/public/companies/upsert", nil, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CompanyRowResult is one row of a bulk company sync.
type CompanyRowResult struct {
	Index      int     `json:"index"`
	ExternalID *string `json:"external_id"`
	// Status: "created", "updated", "invalid", "error" (a concurrent write — retry the row).
	Status         string          `json:"status"`
	CompanyID      string          `json:"company_id,omitempty"`
	UnknownMembers []string        `json:"unknown_members,omitempty"`
	Error          json.RawMessage `json:"error,omitempty"`
}

// BulkCompaniesResult aggregates a bulk company sync.
type BulkCompaniesResult struct {
	Created int                `json:"created"`
	Updated int                `json:"updated"`
	Invalid int                `json:"invalid"`
	Errors  int                `json:"errors"`
	Results []CompanyRowResult `json:"results"`
}

// MaxCompaniesPerRequest is the server's bulk limit; BulkUpsertCompanies splits larger slices.
const MaxCompaniesPerRequest = 200

// BulkUpsertCompanies applies any number of client snapshots, in requests of up to
// MaxCompaniesPerRequest; per-row outcomes in Results.
func (c *Client) BulkUpsertCompanies(ctx context.Context, companies []CompanyInput) (*BulkCompaniesResult, error) {
	total := &BulkCompaniesResult{Results: make([]CompanyRowResult, 0, len(companies))}
	for start := 0; start < len(companies); start += MaxCompaniesPerRequest {
		end := min(start+MaxCompaniesPerRequest, len(companies))
		var part BulkCompaniesResult
		body := map[string]any{"companies": companies[start:end]}
		if err := c.do(ctx, "POST", "/v1/public/companies/bulk", nil, body, &part); err != nil {
			return total, err
		}
		total.Created += part.Created
		total.Updated += part.Updated
		total.Invalid += part.Invalid
		total.Errors += part.Errors
		for _, r := range part.Results {
			r.Index += start
			total.Results = append(total.Results, r)
		}
	}
	return total, nil
}

// GetCompany returns the client with this external id (IsNotFound when unknown).
func (c *Client) GetCompany(ctx context.Context, externalID string) (*Company, error) {
	var out struct {
		Company Company `json:"company"`
	}
	if err := c.do(ctx, "GET", "/v1/public/companies", url.Values{"external_id": {externalID}}, nil, &out); err != nil {
		return nil, err
	}
	return &out.Company, nil
}

// RemoveCompany marks a client deleted in your system. Soft: the company stays (AccountStatus
// "former"); its projects are deleted so they stop counting in technology audiences.
func (c *Client) RemoveCompany(ctx context.Context, externalID string) (*Company, error) {
	var out struct {
		Company Company `json:"company"`
	}
	if err := c.do(ctx, "POST", "/v1/public/companies/remove", nil, map[string]string{"external_id": externalID}, &out); err != nil {
		return nil, err
	}
	return &out.Company, nil
}
