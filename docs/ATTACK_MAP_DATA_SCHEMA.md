# Attack Map — Data Schema

Every data point the Attacked.ai attack map uses, by side-panel card.

---

## Card 1 — Incident Summary (`incidents`)

| Field | Type | Description |
|---|---|---|
| id | bigint | Incident ID (links every other card) |
| headline | text | Incident title |
| summary | text | Incident summary |
| entity | text | Affected organisation |
| sector | text | GICS sector |
| industry | text | Industry (43-industry list) |
| location_name | text | City / place |
| country | text | Country |
| latitude | numeric | Pin latitude |
| longitude | numeric | Pin longitude |
| event_date | date | Date it happened |
| disclosure_date | date | Date it was made public |
| incident_day | date | Timeline day the pin appears on |
| primary_category | text | GUARD category code (CYB, GEO, …) |
| primary_subcategory_code | text | Subcategory code (e.g. GEO-02) |
| primary_subcategory_name | text | Subcategory name |
| secondary_mappings | jsonb[] | Secondary categories (see below) |
| severity | integer | 1–5 |
| severity_rationale | text | Why that severity |
| confidence | text | HIGH / MEDIUM / LOW |
| image_url | text | Incident image |

**secondary_mappings (each item)**

| Field | Type | Description |
|---|---|---|
| category | text | Secondary GUARD category code |
| subcategory_code | text | Subcategory code |
| subcategory_name | text | Subcategory name |
| why | text | Reason for the mapping |
| objective_ids | text[] | Linked control objective IDs |
| master_control_ids | text[] | Linked master control IDs |

---

## Card 2 — Adaptive Controls

**Control objectives (`adaptive_objectives`)**

| Field | Type | Description |
|---|---|---|
| id | bigint | Row ID |
| incident_id | bigint | Incident ID |
| objective_id | text | Objective code (CO-*) |
| statement | text | Objective text |

**Adaptive controls (`adaptive_controls`)**

| Field | Type | Description |
|---|---|---|
| id | bigint | Row ID |
| incident_id | bigint | Incident ID |
| control_id | text | Control code (AC-*) |
| parent_mc_id | text | Parent master control code (MC-*) |
| statement | text | Control text |
| rationale | text | Why it applies |
| kind | text | direct / indirect |

---

## Card 3 — Blast Radius (`blast_radius`)

| Field | Type | Description |
|---|---|---|
| id | bigint | Row ID |
| incident_id | bigint | Incident ID |
| exposure_group | text | Channel (see values below) |
| name | text | Exposed entity |
| type | text | Entity type |
| country | text | Country |
| latitude | numeric | Entity latitude (arc end-point) |
| longitude | numeric | Entity longitude (arc end-point) |
| reason | text | Why it is exposed |
| impact_score | integer | Impact strength |
| impact_rationale | text | Why that score |
| transmission_mechanism | text | How the risk spreads (see values below) |
| impact_horizon | text | When the impact lands (see values below) |
| recommended_action_for_them | text | What the entity should do |

---

## Card 4 — Peer Watchlist (`peer_watchlist`)

| Field | Type | Description |
|---|---|---|
| id | bigint | Row ID |
| incident_id | bigint | Incident ID |
| name | text | Peer organisation |
| country | text | Country |
| latitude | numeric | Peer latitude |
| longitude | numeric | Peer longitude |
| exposure_reason | text | Why the peer is exposed |

---

## Card 5 — Historical Analogues (`historical_analogues`)

| Field | Type | Description |
|---|---|---|
| id | bigint | Row ID |
| incident_id | bigint | Incident ID |
| event_name | text | Past event |
| entity | text | Organisation affected |
| year | integer | Year |
| summary | text | The parallel |
| outcome | text | What happened |

---

## Sources (`sources`)

| Field | Type | Description |
|---|---|---|
| id | bigint | Row ID |
| incident_id | bigint | Incident ID |
| title | text | Article title |
| url | text | Link |
| publisher | text | Publisher |

---

## Reporter (`reporters`)

| Field | Type | Description |
|---|---|---|
| slug | text | Reporter key |
| name | text | Reporter name |
| desk | text | Desk name |
| cats | text[] | GUARD categories covered |
| color | text | Chip colour |

---

## Allowed values

**primary_category (13 GUARD categories)**

| Code | Name |
|---|---|
| CYB | Cyber Security |
| DAT | Data & Privacy |
| TEC | Technology |
| GEO | Geopolitical |
| PHY | Physical Security |
| OPS | Operational |
| TPR | Third-Party Risk |
| REG | Regulatory |
| FIN | Financial |
| STR | Strategic |
| REP | Reputational |
| PPL | People & Human Capital |
| ENV | Environmental |

**severity**

| Value | Label |
|---|---|
| 5 | Critical |
| 4 | High |
| 3 | Medium |
| 2 | Low |
| 1 | Minimal |

**exposure_group**

| Value | Label |
|---|---|
| internal | Internal |
| supply_chain | Supply Chain |
| customer_counterparty | Customer |
| competitive_peer | Peer |
| regulatory | Regulator |
| financial_market | Capital |

**impact_horizon**

| Value | Window |
|---|---|
| immediate | 0–72 hours |
| short | 1–4 weeks |
| medium | 1–6 months |
| long | 6+ months |

**transmission_mechanism**

| Value |
|---|
| shared_technology |
| shared_geography |
| shared_vendor |
| shared_workforce_market |
| supply_chain_link |
| customer_overlap |
| capability_substitution |
| sentiment_contagion |
| regulatory_spillover |

**confidence**

| Value |
|---|
| HIGH |
| MEDIUM |
| LOW |
