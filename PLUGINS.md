# Optional Agent Plugins

Code Agent and Cross-border Market Intelligence remain optional application plugins so the default
QA workspace can start without loading project indexing or Commerce-specific UI/history.

## Commerce plugin

When enabled, Commerce adds:

- independent `commerce` session mode;
- multi-source Data Source Orchestrator;
- provider health/configuration UI;
- structured market report and PDF export.

The provider layer is intentionally independent of the session UI. New providers can implement the
same provider/search or health-check contracts without modifying QA or Code Agent routing.


## v9 core completion rule

The market-intelligence plugin completes from TalorData public SERP / Shopping observations alone. Amazon / Keepa / TikTok / Temu / 1688 credentials are optional enrichers and must never be treated as prerequisites for report generation.
