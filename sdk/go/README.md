# Noola Go SDK

Go client for the Noola **public API** — the api-key surface a system of record (e.g. the Zerops
backend) uses to sync its people, clients, projects and technologies into Noola. Standard library
only, Go 1.22+.

```sh
go get github.com/fxck/noola/sdk/go
```

```go
import noola "github.com/fxck/noola/sdk/go"

client, err := noola.NewClient("https://api.noola.example", os.Getenv("NOOLA_API_KEY"))
```

Create the key in Noola under **Settings → API keys** with the scopes you need:
`contacts:write` (+ `contacts:read`) for people and consent, `accounts:write` (+ `accounts:read`) for
clients, projects and technologies.

## Full sync

`Sync` pushes a complete snapshot — people first (so memberships resolve), then clients with their
members and projects. It is idempotent: run it nightly and/or on every change.

```go
report, err := client.Sync(ctx,
    []noola.ContactInput{
        {ExternalID: user.ID, Email: user.Email, Name: user.Name, Subscribed: noola.Ptr(user.MarketingConsent)},
    },
    []noola.CompanyInput{{
        ExternalID: acc.ID, Name: acc.Name, AvgMonthlySpend: noola.Ptr(acc.Spend), Currency: "EUR",
        Members:  []noola.Member{{ExternalID: user.ID, Role: "owner"}},
        Projects: []noola.Project{{
            ExternalID: p.ID, Name: p.Name, AvgMonthlySpend: noola.Ptr(p.Spend),
            Services: []noola.Service{{Type: "ubuntu/nodejs@22", Hostname: "app"}, {Type: "postgresql:ha@16", Hostname: "db"}},
        }},
    }},
)
if err != nil { /* the request itself failed (network / auth / rate limit after retries) */ }
if !report.OK() { /* row-level problems: report.ContactIssues, report.CompanyIssues, report.UnknownMembers */ }
```

A runnable mapping from Zerops-like models is in [`examples/zerops-sync`](examples/zerops-sync/main.go).

## Semantics worth knowing

- **People are keyed by your id** (`ExternalID`). With no id match, a Noola contact holding the same
  email and **no** external id yet (a chat visitor, an event lead) adopts your id — that's how leads
  become customers without duplicates. An email held by a contact with a *different* id is a
  conflict (`IsConflict`, details in `APIError.Conflict`); nothing is written.
- **Clients are snapshots keyed by your id**, never by name (two clients may share one).
  `Members` / `Projects`: **nil** = leave unchanged (e.g. a spend-only update), **empty** = remove
  all, **non-empty** = exactly this list. Agent-made links in Noola are never touched. Upsert people
  before listing them as members — unknown ids come back in `UnknownMembers`.
- **Services**: send the *resolved* type as the platform has it (`ubuntu/nodejs@22`,
  `postgresql:ha@16`, `php-nginx@8.4+1.22`, `object-storage`) — the deployed version, not `@latest`.
  Noola derives technology / version / OS / HA mode, and with the Zerops catalog (imported by Noola
  itself from the zerops.yml + import.yml schemas) marks versions Zerops no longer offers as EOL.
- **Consent**: `Subscribed: noola.Ptr(false)` opts out. Re-subscribing only undoes an opt-out made
  via the API; if the person unsubscribed themselves, `SetSubscription(ctx, id, true, false)` fails
  with `IsResubscribeBlocked` — pass `force=true` only when they consented again in your system.
  Per-topic opt-outs: `ListTopics`, `SetTopic`.
- **Deletions are soft**: `RemoveContact` / `RemoveCompany` keep the record and its history
  (status `former`); a later upsert revives it.

## Errors and retries

Non-2xx responses are `*noola.APIError` (`StatusCode`, `Message`, `Conflict`, …) with helpers
`IsNotFound`, `IsConflict`, `IsResubscribeBlocked`. Every call is idempotent, so the client retries
429 (honouring `Retry-After`; the API allows 120 requests/min per key) and 5xx with jittered
exponential backoff — tune with `WithRetries`, `WithBackoff`; cancel with the context.

Bulk calls split automatically: `BulkUpsertContacts` sends ≤1000 per request, `BulkUpsertCompanies`
≤200, and row indexes in the results refer to your original slice.

## API coverage

| Method | Endpoint | Scope |
|---|---|---|
| `UpsertContact`, `BulkUpsertContacts` | `POST /v1/public/contacts/upsert`, `/bulk` | contacts:write |
| `GetContact` | `GET /v1/public/contacts?external_id=` | contacts:read |
| `SetSubscription` | `POST /v1/public/contacts/subscription` | contacts:write |
| `RemoveContact` | `POST /v1/public/contacts/remove` | contacts:write |
| `ListTopics`, `SetTopic` | `GET /v1/public/topics`, `POST /v1/public/contacts/topics` | contacts:read / contacts:write |
| `UpsertCompany`, `BulkUpsertCompanies` | `POST /v1/public/companies/upsert`, `/bulk` | accounts:write |
| `GetCompany` | `GET /v1/public/companies?external_id=` | accounts:read |
| `RemoveCompany` | `POST /v1/public/companies/remove` | accounts:write |
| `TechnologyUsage` | `GET /v1/public/technologies` | accounts:read |
| `PutTechnologies` | `PUT /v1/public/technologies` (manual catalog — not needed with the Zerops catalog) | accounts:write |

The full contract is served by the API at `/openapi.json`.

## Tests

```sh
go test ./...                                                     # unit tests (fake server)
NOOLA_TEST_URL=https://api… NOOLA_TEST_KEY=… go test -run TestIntegration ./   # against a live API
```
