package noola

import "context"

// TechnologyUsage is one technology version in use across your synced clients.
type TechnologyUsage struct {
	Technology string `json:"technology"`
	Name       string `json:"name"`
	Category   string `json:"category"`
	Version    string `json:"version"`
	// Status: "supported", "deprecated", "eol", "unknown" (not in a manual catalog). With the Zerops
	// catalog (Noola imports the zerops.yml + import.yml schemas itself) a version Zerops no longer
	// offers is "eol".
	Status       string  `json:"status"`
	Services     int     `json:"services"`
	Projects     int     `json:"projects"`
	Companies    int     `json:"companies"`
	Contacts     int     `json:"contacts"`
	ProjectSpend float64 `json:"project_spend"`
}

// TechnologyUsage returns usage per technology version.
func (c *Client) TechnologyUsage(ctx context.Context) ([]TechnologyUsage, error) {
	var out struct {
		Usage []TechnologyUsage `json:"usage"`
	}
	if err := c.do(ctx, "GET", "/v1/public/technologies", nil, nil, &out); err != nil {
		return nil, err
	}
	return out.Usage, nil
}

// TechnologyCatalog is a manually maintained catalog (PutTechnologies).
type TechnologyCatalog struct {
	Technologies []CatalogTechnology `json:"technologies"`
}

// CatalogTechnology is one catalog entry; Aliases fold spelling variants onto Key (golang → go).
type CatalogTechnology struct {
	Key      string           `json:"key"`
	Name     string           `json:"name,omitempty"`
	Category string           `json:"category,omitempty"`
	Aliases  []string         `json:"aliases"`
	Versions []CatalogVersion `json:"versions"`
}

// CatalogVersion is a version and its lifecycle status: "supported", "deprecated" or "eol".
type CatalogVersion struct {
	Version string `json:"version"`
	Status  string `json:"status"`
}

// PutTechnologies REPLACES the catalog with a manual one. You don't need this for Zerops: Noola
// imports the Zerops catalog itself (Technologies → "Use Zerops catalog"), and a manual push turns
// that import off.
func (c *Client) PutTechnologies(ctx context.Context, catalog TechnologyCatalog) error {
	for i := range catalog.Technologies {
		if catalog.Technologies[i].Aliases == nil {
			catalog.Technologies[i].Aliases = []string{}
		}
		if catalog.Technologies[i].Versions == nil {
			catalog.Technologies[i].Versions = []CatalogVersion{}
		}
	}
	return c.do(ctx, "PUT", "/v1/public/technologies", nil, catalog, nil)
}
