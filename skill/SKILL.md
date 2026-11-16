---
name: drawio-to-archify
description: Turn an existing .drawio AWS architecture into presentable, interactive Archify HTML views for different audiences - an executive view in plain language and a technical view. Load when the user wants a draw.io diagram made easier to present, explain or share with a mixed audience.
---

# draw.io -> Archify audience views

One draw.io file in, one HTML view per audience out. The draw.io file stays the source of truth and is never modified.

| View | Audience | Shows |
|---|---|---|
| Executive | Business owners, management, non-technical stakeholders | 5-9 plain-language blocks (Front door, Application, Business data...), how they connect, a "What's inside" card naming the AWS services, a resilience card when the drawing shows multiple AZs |
| Technical | Architects, engineers, reviewers | 8-12 AWS components with real names and edge labels, repeated per-AZ items folded into one node, network and resilience detail in cards |

## Requirements

- Node 18+.
- The Archify skill installed ([tt-a1i/archify](https://github.com/tt-a1i/archify), Apache-2.0; all rendering credit goes to that project). Read its `SKILL.md` before the first conversion; its rules win over this file.
- `ARCHIFY` below means the absolute path to Archify's `bin/archify.mjs`. `REPO` means the folder that contains this skill's `scripts/` and `glossary/`.

## Steps

1. **Inventory.** Run the parser. It reads compressed or uncompressed draw.io files.

   ```bash
   node REPO/scripts/drawio-inventory.mjs <file.drawio> --out <work>/inventory.json \
     --executive-draft <work>/executive/candidate.json \
     --title "<System> - how it works" --html executive/<slug>-executive.html
   ```

   Use `--page <n|name>` for multi-page files. `<work>` is the output folder; run Archify from it so `meta.output` paths resolve.

2. **Stop on flags.** Read `report.flags` in the inventory (prices, account IDs, CIDRs/IPs, emails, "internal"/"confidential" wording). Do not carry any flagged text into either view unless the user says so. The parser already keeps free-text notes out of the executive draft.

3. **Check gaps.** `report.unknownServices` lists shapes the glossary does not know: ask the user or add them to `glossary/aws.json`, never guess. `report.unconnectedNodes`, `report.danglingEdges` and `report.groupEndpoints` show what cannot be linked; mention them, do not invent links.

4. **Executive view.** The draft is built only from the drawing: blocks come from glossary layers, links exist only where the drawing has a path between members (contracted through omitted plumbing such as NAT gateways). You may reword labels, sublabels and cards for the audience. Do not add links, blocks or claims the drawing does not support. Keep it under about 9 blocks.

5. **Technical view.** Author `<work>/technical/candidate.json` by hand from the inventory, following Archify's architecture rules:
   - one component per fold candidate in `report.folds`, with the count or roles in `tag` (e.g. "2 AZs", "writer + reader");
   - edge labels copied from the drawing;
   - VPC, subnets, accounts and NAT go in cards, because Archify boundaries are only `region` and `security-group`;
   - global services drawn outside the Region stay outside the region boundary.

6. **Finalize each view** (from `<work>`):

   ```bash
   node ARCHIFY finalize architecture executive/candidate.json executive/<slug>-executive.html --quality showcase --json
   node ARCHIFY finalize architecture technical/candidate.json technical/<slug>-technical.html --quality showcase --json
   ```

   Repair only as Archify's diagnostics direct, at most two rounds. If only `browser-check` fails with `viewer/browser-check-runtime`, that is the host's browser launch, not the diagram: report validate/deliver/check results and say the browser gate did not run.

7. **Report** the two HTML links, what was folded or omitted, any flags held back, and whether a person has visually reviewed the result.

## Rules

- Never invent CIDRs, ports, protocols, directions, counts or services.
- Never mix customers. Write outputs next to the source drawing or in a folder the user names.
- Archify HTML cannot animate inside Word or PowerPoint; use its PNG/SVG export there.
- Set `ARCHIFY_UPDATE_CHECK_DISABLED=1` to stop Archify's update-check network call.
