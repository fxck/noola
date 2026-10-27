package noola

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"
)

// ContactInput is one person, keyed by YOUR stable id. Empty Email / Name leave the stored value
// unchanged.
//
// Matching: an existing contact with this ExternalID is updated; otherwise a contact holding Email
// with no external id yet (e.g. a chat-widget visitor, an event lead) gets the id attached. An Email
// held by a contact with a DIFFERENT external id is a conflict — nothing is written.
type ContactInput struct {
	ExternalID string `json:"external_id"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
	// Subscribed mirrors marketing consent: false opts out; true re-subscribes only an opt-out the
	// API made (otherwise the result carries the "resubscribe_blocked" warning — see SetSubscription).
	// nil leaves consent unchanged.
	Subscribed *bool `json:"subscribed,omitempty"`
}

// Contact is a person as Noola holds it.
type Contact struct {
	ID         string  `json:"id"`
	ExternalID *string `json:"external_id"`
	Email      *string `json:"email"`
	Name       string  `json:"name"`
	Subscribed bool    `json:"subscribed"`
	// UnsubscribedSource: "api", "contact" (their own unsubscribe), "agent", "import"; nil while subscribed.
	UnsubscribedAt     *time.Time `json:"unsubscribed_at"`
	UnsubscribedSource *string    `json:"unsubscribed_source"`
	// AccountStatus: "customer" (member of a live synced client), "user" (synced, no client),
	// "former" (removed in your system), "lead" (never synced).
	AccountStatus string     `json:"account_status"`
	SyncedAt      *time.Time `json:"synced_at"`
	SyncRemovedAt *time.Time `json:"sync_removed_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// Warning codes a contact upsert may return.
const WarningResubscribeBlocked = "resubscribe_blocked"

// UpsertContactResult is the outcome of UpsertContact.
type UpsertContactResult struct {
	Contact Contact `json:"contact"`
	Created bool    `json:"created"`
	// MatchedBy: "external_id", "email" (an id-less contact adopted the id), or "" when created.
	MatchedBy string   `json:"matched_by"`
	Warnings  []string `json:"warnings"`
}

// UpsertContact creates or updates one person. A taken email returns an *APIError with StatusCode
// 409 and Conflict set (IsConflict).
func (c *Client) UpsertContact(ctx context.Context, in ContactInput) (*UpsertContactResult, error) {
	if in.ExternalID == "" {
		return nil, errors.New("noola: ContactInput.ExternalID is required")
	}
	var out UpsertContactResult
	if err := c.do(ctx, "POST", "/v1/public/contacts/upsert", nil, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ContactRowResult is one row of a bulk upsert.
type ContactRowResult struct {
	// Index is the row's position in the slice passed to BulkUpsertContacts.
	Index      int     `json:"index"`
	ExternalID *string `json:"external_id"`
	// Status: "created", "updated", "conflict" (email held by another contact), "invalid".
	Status    string    `json:"status"`
	ContactID string    `json:"contact_id,omitempty"`
	MatchedBy *string   `json:"matched_by,omitempty"`
	Warnings  []string  `json:"warnings,omitempty"`
	Conflict  *Conflict `json:"conflict,omitempty"`
	// Error is the conflict message or the validation detail (JSON) for an invalid row.
	Error json.RawMessage `json:"error,omitempty"`
}

// BulkContactsResult aggregates a bulk upsert.
type BulkContactsResult struct {
	Created   int                `json:"created"`
	Updated   int                `json:"updated"`
	Conflicts int                `json:"conflicts"`
	Invalid   int                `json:"invalid"`
	Results   []ContactRowResult `json:"results"`
}

// MaxContactsPerRequest is the server's bulk limit; BulkUpsertContacts splits larger slices.
const MaxContactsPerRequest = 1000

// BulkUpsertContacts upserts any number of people, in requests of up to MaxContactsPerRequest. A
// bad or conflicting row is reported in Results and skipped; every other row is saved.
func (c *Client) BulkUpsertContacts(ctx context.Context, contacts []ContactInput) (*BulkContactsResult, error) {
	total := &BulkContactsResult{Results: make([]ContactRowResult, 0, len(contacts))}
	for start := 0; start < len(contacts); start += MaxContactsPerRequest {
		end := min(start+MaxContactsPerRequest, len(contacts))
		var part BulkContactsResult
		body := map[string]any{"contacts": contacts[start:end]}
		if err := c.do(ctx, "POST", "/v1/public/contacts/bulk", nil, body, &part); err != nil {
			return total, err
		}
		total.Created += part.Created
		total.Updated += part.Updated
		total.Conflicts += part.Conflicts
		total.Invalid += part.Invalid
		for _, r := range part.Results {
			r.Index += start
			total.Results = append(total.Results, r)
		}
	}
	return total, nil
}

// GetContact returns the person with this external id (IsNotFound when unknown).
func (c *Client) GetContact(ctx context.Context, externalID string) (*Contact, error) {
	var out struct {
		Contact Contact `json:"contact"`
	}
	if err := c.do(ctx, "GET", "/v1/public/contacts", url.Values{"external_id": {externalID}}, nil, &out); err != nil {
		return nil, err
	}
	return &out.Contact, nil
}

// SetSubscription sets marketing consent. Opting out always succeeds. Re-subscribing a person who
// opted out outside the API (their own unsubscribe link, an agent, an import) fails with
// IsResubscribeBlocked unless force is true — pass force only when they consented again in your
// system; forced re-subscribes are audited in Noola.
func (c *Client) SetSubscription(ctx context.Context, externalID string, subscribed, force bool) (*Contact, error) {
	body := map[string]any{"external_id": externalID, "subscribed": subscribed}
	if force {
		body["force"] = true
	}
	var out struct {
		Contact Contact `json:"contact"`
	}
	if err := c.do(ctx, "POST", "/v1/public/contacts/subscription", nil, body, &out); err != nil {
		return nil, err
	}
	return &out.Contact, nil
}

// RemoveContact marks a person deleted in your system. Soft: the contact and its conversations stay
// (AccountStatus "former") and it leaves its synced clients; a later upsert revives it.
func (c *Client) RemoveContact(ctx context.Context, externalID string) (*Contact, error) {
	var out struct {
		Contact Contact `json:"contact"`
	}
	if err := c.do(ctx, "POST", "/v1/public/contacts/remove", nil, map[string]string{"external_id": externalID}, &out); err != nil {
		return nil, err
	}
	return &out.Contact, nil
}

// Topic is a subscription topic (e.g. "Product updates", "EOL notices").
type Topic struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// TopicState is one topic and whether a contact receives it.
type TopicState struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Subscribed bool   `json:"subscribed"`
}

// ListTopics returns the workspace's subscription topics.
func (c *Client) ListTopics(ctx context.Context) ([]Topic, error) {
	var out struct {
		Topics []Topic `json:"topics"`
	}
	if err := c.do(ctx, "GET", "/v1/public/topics", nil, nil, &out); err != nil {
		return nil, err
	}
	return out.Topics, nil
}

// SetTopic opts a person out of (subscribed=false) or back into one topic and returns all their
// topic states. The global opt-out (SetSubscription) still overrides every topic.
func (c *Client) SetTopic(ctx context.Context, externalID, topicID string, subscribed bool) ([]TopicState, error) {
	body := map[string]any{"external_id": externalID, "topic_id": topicID, "subscribed": subscribed}
	var out struct {
		Topics []TopicState `json:"topics"`
	}
	if err := c.do(ctx, "POST", "/v1/public/contacts/topics", nil, body, &out); err != nil {
		return nil, err
	}
	return out.Topics, nil
}
