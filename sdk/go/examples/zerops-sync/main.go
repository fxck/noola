// Command zerops-sync shows how a Zerops-like backend maps its users, clients, projects and services
// onto Noola and syncs them. Replace loadFromZerops with queries against your own data.
//
//	NOOLA_URL=https://api.noola.example NOOLA_API_KEY=... go run ./examples/zerops-sync
package main

import (
	"context"
	"log"
	"os"
	"time"

	noola "github.com/fxck/noola/sdk/go"
)

// ── Your side (stand-ins for the Zerops backend's own models) ───────────────────────

type User struct {
	ID, Email, FullName string
	MarketingConsent    bool
}

type ClientAccount struct {
	ID, Name        string
	AvgMonthlySpend float64 // average monthly spend, EUR
	Members         []Membership
	Projects        []ZProject
}

type Membership struct {
	UserID, Role string
}

type ZProject struct {
	ID, Name, Status string
	AvgMonthlySpend  float64
	Services         []ZService
}

type ZService struct {
	ID, Hostname string
	// ServiceStackType is the RESOLVED type, e.g. "ubuntu/nodejs@22", "postgresql:ha@16".
	ServiceStackType string
}

func loadFromZerops() ([]User, []ClientAccount) {
	users := []User{
		{ID: "u_8f2kd93ks0a1b2c3d4e5f6", Email: "jan.novak@example.com", FullName: "Jan Novák", MarketingConsent: true},
		{ID: "u_1a2b3c4d5e6f7g8h9i0j1k", Email: "petra@example.com", FullName: "Petra Svobodová", MarketingConsent: false},
	}
	clients := []ClientAccount{{
		ID: "c_7h6g5f4e3d2c1b0a9z8y7x", Name: "Acme s.r.o.", AvgMonthlySpend: 320,
		Members: []Membership{{UserID: users[0].ID, Role: "owner"}, {UserID: users[1].ID, Role: "developer"}},
		Projects: []ZProject{{
			ID: "p_0q9w8e7r6t5y4u3i2o1p0a", Name: "eshop", Status: "active", AvgMonthlySpend: 250,
			Services: []ZService{
				{ID: "s_1", Hostname: "app", ServiceStackType: "ubuntu/nodejs@22"},
				{ID: "s_2", Hostname: "db", ServiceStackType: "postgresql:ha@16"},
			},
		}},
	}}
	return users, clients
}

// ── Mapping ─────────────────────────────────────────────────────────────────────────

func toContacts(users []User) []noola.ContactInput {
	out := make([]noola.ContactInput, 0, len(users))
	for _, u := range users {
		out = append(out, noola.ContactInput{
			ExternalID: u.ID,
			Email:      u.Email,
			Name:       u.FullName,
			Subscribed: noola.Ptr(u.MarketingConsent),
		})
	}
	return out
}

func toCompanies(clients []ClientAccount) []noola.CompanyInput {
	out := make([]noola.CompanyInput, 0, len(clients))
	for _, cl := range clients {
		members := make([]noola.Member, 0, len(cl.Members)) // non-nil: the full member list
		for _, m := range cl.Members {
			members = append(members, noola.Member{ExternalID: m.UserID, Role: m.Role})
		}
		projects := make([]noola.Project, 0, len(cl.Projects)) // non-nil: the full project list
		for _, p := range cl.Projects {
			services := make([]noola.Service, 0, len(p.Services))
			for _, s := range p.Services {
				services = append(services, noola.Service{Type: s.ServiceStackType, Hostname: s.Hostname, ExternalID: s.ID})
			}
			projects = append(projects, noola.Project{
				ExternalID: p.ID, Name: p.Name, Status: p.Status,
				AvgMonthlySpend: noola.Ptr(p.AvgMonthlySpend), Services: services,
			})
		}
		out = append(out, noola.CompanyInput{
			ExternalID: cl.ID, Name: cl.Name,
			AvgMonthlySpend: noola.Ptr(cl.AvgMonthlySpend), Currency: "EUR",
			Members: members, Projects: projects,
		})
	}
	return out
}

func main() {
	client, err := noola.NewClient(os.Getenv("NOOLA_URL"), os.Getenv("NOOLA_API_KEY"),
		noola.WithUserAgent("zerops-backend-sync"))
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	users, clients := loadFromZerops()
	report, err := client.Sync(ctx, toContacts(users), toCompanies(clients))
	if err != nil {
		log.Fatalf("sync failed: %v", err)
	}
	log.Println(report)
	for _, r := range report.ContactIssues {
		log.Printf("contact row %d (%v): %s %s", r.Index, deref(r.ExternalID), r.Status, r.Error)
	}
	for _, r := range report.CompanyIssues {
		log.Printf("company row %d (%v): %s %s", r.Index, deref(r.ExternalID), r.Status, r.Error)
	}
	for company, ids := range report.UnknownMembers {
		log.Printf("company %s: unknown members %v", company, ids)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
