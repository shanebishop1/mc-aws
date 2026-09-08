# Orca Feature Parity Research

Research date: 2026-09-01

## Planning status

This inventory compares the research-date baseline with public competitor claims; it is not a current implementation
status report or a release backlog. The later
[Agent Foundation PRD](epics/ec2-agent-platform/live-server-agent-foundation/prds/first-shippable-ec2-agent-foundation.md)
is authoritative for scope and supersedes the recommended order below. The current priority is a capable confined
operator for one real server, not full Orca parity. Clone/testing recommendations for future generated content must not
be imported as mandatory duplicate-world requirements for ordinary agent work. Follow the PRD's maintenance modes,
qualification gates and explicit capability exclusions instead.

## Purpose

This report inventories the public capabilities of [Orca Client](https://orcaclient.com/), compares them with mc-aws v0.2.3, and identifies the work required for meaningful feature parity. It is a product-planning artifact, not an endorsement of Orca's claims and not a commitment to reproduce every feature.

The useful target is not literal screen-for-screen parity. The target is to match the user outcomes that matter while preserving mc-aws's stronger properties: infrastructure ownership, inspectable source, conservative security boundaries, explicit cost, deterministic non-AI operation, and recoverability.

## Evidence standard

Each Orca capability is labeled using one of these levels:

| Label | Meaning |
| --- | --- |
| Observed | A public product surface was exercised with a browser without authentication. This proves the surface exists, not that the underlying operation works reliably. |
| Documented live | Orca's current detailed documentation says the feature works today. It was not exercised in an authenticated or paid environment. |
| Demonstrated | First-party videos, public generated projects, or downloadable artifacts demonstrate at least one example. |
| Marketing claim | Promotional copy asserts the capability without enough public technical evidence to evaluate reliability or scope. |
| Roadmap | Orca explicitly says the feature is not generally available. It is not part of the current parity target. |

mc-aws status uses `Implemented`, `Partial`, `Missing`, or `Different`. `Missing` does not automatically mean `Should build`.

## Sources reviewed

### Official product surfaces

- [Homepage](https://orcaclient.com/)
- [Documentation](https://orcaclient.com/docs)
- [AI server manager](https://orcaclient.com/ai-server-manager)
- [Hosting](https://orcaclient.com/hosting)
- [Pricing](https://orcaclient.com/pricing)
- [Public catalog](https://orcaclient.com/browse)
- [Desktop downloads](https://orcaclient.com/download)
- [Minecraft CLI](https://orcaclient.com/minecraft-cli)
- [Minecraft MCP](https://orcaclient.com/minecraft-mcp)
- [Connect a Pterodactyl server](https://orcaclient.com/docs/connecting-a-pterodactyl-server)
- [Safety and Guardian](https://orcaclient.com/docs/safety-and-guardian)
- [Roadmap](https://orcaclient.com/docs/coming-soon)

### Public company and code material

- [Y Combinator profile](https://www.ycombinator.com/companies/orca-client)
- [GitHub organization](https://github.com/orca-gamedev)
- [img2blockbench](https://github.com/orca-gamedev/img2blockbench)
- [orca-engine](https://github.com/orca-gamedev/orca-engine)
- [orca-mods](https://github.com/orca-gamedev/orca-mods)

### Browser observations

The public homepage, docs, catalog, app shell, CLI, MCP, safety, build-loop, Pterodactyl-connect, and server-directory surfaces were inspected with a clean browser session.

- The anonymous app exposes a project prompt, game selection, model selection, attachments, a bring-your-own-key entry point, and sign-in prompts.
- Anonymous host management is gated behind sign-in.
- The public catalog exposes type, loader, category, and sort filters with direct Play and Host actions.
- Public server pages expose join/copy actions and related-server discovery.
- A featured public creation page, `/creations/c4-explosives`, returned HTTP 500 during research. This is a point-in-time observation, not a general availability conclusion.
- No authenticated, paid, server-mutating, binary-installation, or cloud operation was attempted.

## Executive assessment

Orca is broader than mc-aws today. It combines five products:

1. An AI Minecraft creation environment.
2. A catalog and public discovery layer.
3. A hosted server control panel.
4. A desktop launcher.
5. Agent-facing CLI and MCP interfaces.

mc-aws is materially deeper in a narrower area. It has unusually careful lifecycle serialization, hibernation with volume removal, backup/restore recovery, provider ownership checks, deployment recovery, cost visibility, and conservative infrastructure teardown. Orca's public material does not demonstrate comparable implementation depth in those areas.

The largest missing product surfaces are:

- Mod, plugin, modpack, loader, and version lifecycle management.
- Live console, file management, settings, player, and whitelist administration.
- Evidence-linked diagnostics and performance tooling.
- Complete JSON CLI and MCP interfaces.
- AI-assisted operations with typed policy and confirmation boundaries.
- Reproducible prompt-to-source build and test workflows.
- Multi-server/team support, crossplay, public invitations, and external provider adapters.
- Catalog, publishing, creator profiles, and discovery.

The highest-value sequence is not Orca's visual breadth. It is safe operations first, then content lifecycle, then agent interfaces, then creation.

## Capability matrix

### Creation and generated content

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| Plain-English project creation | Observed | Missing | No creation workspace or generation service | Build after deterministic build/test primitives exist |
| Fabric mod generation | Documented live; public examples | Missing | No source scaffolding, compiler sandbox, or artifact pipeline | P1 creation target after Paper plugins |
| Forge mod generation | Documented live | Missing | Same, with a larger compatibility surface | Defer until Fabric is reliable |
| NeoForge mod generation | Documented live | Missing | Same | Defer until Fabric is reliable |
| Paper plugin generation | Documented live | Missing | No plugin project/build pipeline | First prompt-to-code target |
| Spigot/Bukkit plugin generation | Documented live | Missing | No plugin project/build pipeline | Obtain through Paper-compatible templates where valid |
| Bedrock add-on generation | Documented live | Missing | No Bedrock project tooling | Later roadmap; use standard bridge./Blockbench formats |
| Datapack generation | Documented live | Different | Profiles can carry datapacks, but cannot generate them | Early narrow creation target |
| Resource-pack generation | Documented live | Missing | No asset workflow | Later, using conventional project formats |
| Shader generation | Documented live | Missing | No shader workflow or client launcher | Low priority |
| Modpack/server-pack generation | Documented live | Missing | No dependency resolver or lockfile | First implement reproducible installation, then authoring |
| Texture generation/editor | Documented live | Missing | No asset generator or editor | Integrate open tools instead of building a proprietary editor |
| Custom mobs and Blockbench models | Documented and open-code evidence | Missing | No model pipeline | Later; interoperable `.bbmodel` and Bedrock outputs |
| Image/file attachment to a prompt | Observed | Missing | No upload or prompt surface | Require strict archive/image limits and untrusted-input handling |
| Upload and remix owned/licensed artifacts up to 100 MB | Documented live | Missing | Profiles accept bounded files but not arbitrary JAR remixing | Only after license, archive, sandbox, and provenance controls |
| Exact loader/version targeting | Documented live | Partial | Bootstrap pins one Paper version; profiles do not model loaders | Core declarative profile requirement |
| Java versions back to Minecraft 1.12.2 | Documented live | Missing | One pinned modern Paper runtime | Support an explicit tested matrix, not a blanket promise |
| Auto-generate code, textures, models, and build files | Documented live | Missing | No build service | Build from official templates with pinned toolchains |
| Compile-and-repair loop | Documented live | Missing | CI compiles mc-aws, not generated Minecraft projects | Implement bounded repair with retained logs and attempt limits |
| Disposable server load test | Documented live | Missing | No disposable clone/test runtime | Required before generated artifact deployment |
| Signed generated builds | Documented live | Missing | External artifacts can be SHA-256 pinned but are not signed by mc-aws | Add provenance and signatures, without calling them proof of safety |
| Browser source workspace | Documented live | Missing | No project workspace | Prefer Git repositories and standard editors first |
| Texture/source iteration and rebuild | Documented live | Missing | No generated project lifecycle | Support conventional source, lockfiles, and repeatable rebuilds |
| Reuse work across creations | Documented live | Missing | No project/component model | Later, through versioned source dependencies |
| Publish creation to a public gallery | Documented live | Missing | No public creation entity | Defer until creation and moderation are mature |
| Shareable creation page and creator profile | Documented live | Missing | No marketplace/community identity | Later ecosystem phase |
| Free public artifact downloads | Documented live | Missing | No artifact distribution service | Later ecosystem phase |

### Catalog, discovery, and play

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| Browse tens of thousands of Modrinth-backed projects | Observed/documented live | Missing | No catalog integration | Add search only when safe installation exists |
| Filter by type, loader, category, popularity, downloads, and date | Observed | Missing | No content inventory UI | Add with catalog integration |
| One-click Host from a catalog item | Observed | Missing | Profiles are local and not live-applied | Implement plan, resolve, test, approve, then deploy instead of blind one-click |
| One-click Play from a catalog item | Observed | Missing | No desktop launcher/client management | Not a near-term core goal |
| Public server directory | Observed | Missing | Single private server, no discovery | Optional later community feature |
| Server detail and related-server pages | Observed | Missing | No public listing model | Optional later community feature |
| Windows desktop launcher | Observed distribution surface | Missing | Browser panel only | Avoid until server platform is mature |
| macOS desktop launcher | Observed distribution surface | Missing | Browser panel only | Avoid until server platform is mature |
| Linux desktop launcher | Observed distribution surface | Missing | Browser panel only | Avoid until server platform is mature |
| One-click modded Java launch | Documented live | Missing | No client instance manager | Potential separate project, not core control-plane work |
| Manual JAR download and install | Documented live | Missing | No generated artifact downloads | Creation phase |
| Public invite links | Documented live | Missing | Connection address is displayed, but no scoped invite model | Add safe friend wake/invite links before a launcher |
| Friend join without Orca account | Documented live | Different | Minecraft address can be shared; web actions require Google role | Existing game join already works; improve wake authorization separately |

### Hosting and server lifecycle

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| Server provisioning in about 30 seconds | Marketing claim | Different | Setup provisions owned AWS infrastructure and is slower | Optimize repeat provisioning after profiles and images are reproducible |
| Hosted 8 GB server | Documented offer | Different | Default is owned `t4g.medium` with 3.2 GiB heap | Keep user-selected infrastructure and honest sizing |
| Free daily runtime allowance | Documented offer | Different | User pays cloud provider directly | Do not compete by subsidizing compute |
| Scale/sleep while empty | Documented live | Implemented | mc-aws stops after validated zero-player streak | Preserve and improve wake UX |
| World persistence while asleep | Documented live | Implemented | EBS persists when stopped; Drive persists when hibernated | mc-aws has a strong ownership/recovery story |
| Remove idle storage cost | Not described | Implemented | Orca keeps persistent hosting storage | Keep as a differentiated hibernate mode |
| Vanilla server | Documented live | Missing | Paper only | Profile/runtime matrix |
| Paper server | Documented live | Implemented | One pinned Paper version | Generalize safely |
| Fabric server | Documented live | Missing | No loader/runtime selection | High-priority content phase |
| Forge server | Documented live | Missing | No loader/runtime selection | After Fabric |
| NeoForge server | Documented live | Missing | No loader/runtime selection | After Fabric |
| Purpur/Folia compatibility | Documented | Missing | Paper only | Add only through tested profiles |
| 6,000+ modpacks | Marketing/catalog claim | Missing | No modpack resolver | Use upstream APIs and an immutable lockfile |
| Java/Bedrock crossplay with Geyser/Floodgate | Documented live | Missing | Java TCP only | Valuable P1/P2 profile |
| World upload | Documented live | Partial | Restore accepts safe mc-aws backup archives, not arbitrary world upload | Add staged validated import |
| Region selection | Documented live | Partial | AWS region is configured during setup | Make profile/provider placement explicit |
| Multiple servers per account | Documented live | Missing | One managed EC2/server and global lock | Major architecture boundary; do after single-server domain API |
| External Pterodactyl import | Documented live | Missing | AWS/mock providers only | Add provider adapters after canonical operation contracts |
| Public dedicated Bedrock address for hosted public servers | Documented live | Missing | No Bedrock UDP path | Crossplay/networking phase |
| Manual start/stop/restart | Documented live | Implemented | Start and stop exist; restart is not a first-class action | Add typed restart |
| Automatic join-to-start | Not clearly documented as live | Missing | Friends use panel Start after Google auth | Add a protocol-aware or scoped friend wake path |

### Panel and administration

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| Power controls | Documented live | Implemented | Start/stop/hibernate/resume are stronger than simple power controls | Preserve |
| Live console | Documented live | Partial | SSM helper exists for operators, not the web panel | Add audited, role-scoped web console |
| Live logs | Documented live | Partial | CloudWatch/SSM logs exist, but no panel log viewer | Add sanitized log viewer and diagnostic bundles |
| File manager | Documented live | Missing | No panel file manager | Add constrained server-root file operations after policy model |
| Settings editor | Documented live | Partial | Properties live in profiles; no safe live editor | Add semantic profile changes with plans |
| Difficulty and gamemode controls | Documented live | Missing | Requires profile or console access | Typed operation |
| Whitelist management | Documented live | Partial | Web allowlist controls panel users, not Minecraft whitelist | Add Minecraft player/whitelist administration |
| Player administration | Documented live | Partial | Player count only | Add online list, OP/ban/whitelist actions with audit |
| Team roles | Documented live | Partial | Admin/allowed/public roles exist; one configured admin and no team object | Add least-privilege server roles and invitations |
| Installed mods/plugins inventory | Documented live | Missing | Profile plugin manifest is input-only | Add resolved inventory and drift status |
| Server creation/listing from chat | Documented live | Missing | Single server | Multi-server phase |
| Console commands from chat | Documented live | Missing | No AI or typed command endpoint | Add allowlisted typed commands before arbitrary command execution |
| Install mod/modpack/plugin from chat | Documented live | Missing | No resolver or staged deploy | Content lifecycle, then agent interface |
| Build custom mod/plugin onto live server | Documented live | Missing | No creation pipeline | Require clone/test/backup/promotion, not direct live generation |
| Crash-log diagnosis | Documented live | Missing | No user-facing diagnostics | Highest-priority AI-adjacent feature |
| Automatic crash changes without approval | Orca says it does not silently mutate | Missing | No assistant | Match the conservative approval model |

### CLI, API, and agent interfaces

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| Local CLI | Documented live | Partial | Repository CLI covers lifecycle actions | Complete current CLI first |
| Structured JSON | Documented live | Missing/partial | CLI output is not a complete stable operation contract | Add versioned JSON schemas |
| Command/action discovery | Observed | Missing | Static commands only | Add machine-readable capabilities |
| Instance inspection | Documented live | Missing | No client instances | Not core |
| Installed mod inspection | Documented live | Missing | No resolved inventory | Content lifecycle phase |
| Launch and dry-run | Observed | Partial | Deployment scripts have dry-run-like guards; server CLI does not model plans | Add semantic plan/dry-run to mutations |
| Explicit target selectors | Documented live | Partial | One server removes ambiguity | Required before multi-server support |
| Explicit confirmation | Documented live | Partial | Setup/teardown confirm; panel mutations use role checks | Standardize risk-based confirmation |
| Operation completion polling | Documented live surface | Partial | mc-aws CLI reports acceptance but does not poll terminal state | Immediate small gap |
| Hosted MCP endpoint | Observed | Missing | No MCP server | Add after canonical typed operations |
| OAuth-based MCP authorization | Documented live | Missing | Cookie auth only | Use OAuth 2.1/PKCE, audience-bound scopes, no token passthrough |
| MCP project scaffolding | Observed | Missing | No generation projects | Creation phase |
| MCP build tracking | Documented live | Missing | No generated builds | Creation phase |
| MCP load testing | Observed | Missing | No disposable project test runtime | Creation phase |
| MCP apply-to-server | Observed | Missing | No artifact promotion pipeline | Only after backup/test/policy gates |
| Bring-your-own AI assistant | Documented live | Missing | No agent contract | Prefer model-neutral interfaces |
| Bring-your-own chat key | Observed anonymous app surface | Missing | No AI provider configuration | Later; secrets must stay outside prompts and logs |

### Safety, trust, and governance

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| AI action scopes and logs | Documented live | Different | No AI; lifecycle audit state is structured but not a durable user audit trail | Build an immutable operation audit before AI mutations |
| Refusal of destructive/abusive requests | Documented live | Different | No AI; routes enforce role and precondition checks | Encode deterministic policy outside the model |
| Content moderation for published work | Documented live | Missing | No publishing | Required only with public ecosystem |
| Upload scanning | Marketing/documented claim | Partial | Profiles reject links, special files, credential patterns, and unpinned plugins | Extend with archive, SBOM, malware, and provenance checks |
| Malware/RCE scanning | Marketing/documented claim | Missing | No general artifact scanner | Add defense in depth without promising proof of safety |
| Signed generated builds | Documented live | Missing | SHA-pinned external plugins only | Add provenance attestations and signatures |
| Desktop rejection of unsigned builds | Documented live | Missing | No desktop client | Not needed without launcher |
| Account-scoped server actions | Documented live | Implemented | Roles and owner/admin operation polling exist | Extend to per-server RBAC |
| Visible action steps | Documented live | Partial | Async operation phases exist in UI | Expand to semantic before/after plans |
| Infrastructure ownership and inspectable deployment | Not an Orca property | Implemented | mc-aws advantage | Preserve as a non-negotiable principle |
| Backup-backed hibernation and volume removal | Not described by Orca | Implemented | mc-aws advantage | Preserve and strengthen with restore proof |
| Exact-resource teardown with preservation gates | Not described by Orca | Implemented | mc-aws advantage | Preserve |
| Cost dashboard and direct provider billing | Not an Orca property | Implemented | mc-aws advantage | Expand into per-operation cost estimates |

### Community and commercial surfaces

| Orca capability | Evidence | mc-aws | Gap | Recommended disposition |
| --- | --- | --- | --- | --- |
| Google and Discord sign-in | Documented live | Partial | Google only | Add OIDC provider abstraction before provider-specific buttons |
| Minecraft account linking | Documented live | Missing | Google roles are separate from player identity | Useful for player/admin policy |
| Credits and subscription tiers | Observed/documented | Different | Self-hosted, direct cloud billing | Do not add unless a hosted service is created |
| RAM add-ons | Documented live | Different | Instance type is operator-selected through deployment config | Add safe resize/profile planning instead |
| Affiliate program | Documented live | Missing | No commercial service | Not core open-source scope |
| Creator partnership program | Documented live | Missing | No hosted creator service | Optional later go-to-market program |
| Public creator analytics | Conflicting/roadmap | Missing | No creator platform | Do not count as live parity |

## Orca roadmap items explicitly excluded from current parity

Orca says these are built or in testing but not generally live:

- Player retention, DAU, MAU, session, and supporter analytics.
- Server health score.
- Discord and webhook alerts.
- Traffic-source attribution.
- Tebex monetization.
- One-click server presets.
- Chat-based server version/loader switching.
- Automatic snapshot backups with one-click restore.
- Chat-based file management.
- In-game bot management.

mc-aws already has alarm email, scheduled backup monitoring, and Google Drive restore, but those are not equivalent implementations of Orca's roadmap descriptions.

## Important uncertainties and conflicts

1. Orca's current documentation requires a desktop client for Java play, while earlier launch material promoted browser play. Current documentation should control the comparison.
2. The homepage suggests prompts such as “Upgrade to 1.21” and “Switch to Fabric,” while the roadmap says chat-based loader/version switching is not live.
3. The CLI/MCP pages show skin generation, while one detailed capability page reportedly says AI skin generation is unavailable. Treat skin generation as unresolved.
4. The creator program advertises analytics, while the roadmap says analytics are not user-accessible. Private partner tooling may exist but was not verified.
5. A successful compile and server boot does not prove semantic correctness, performance, security, multiplayer behavior, or upgrade safety.
6. Signed artifacts prove provenance and integrity, not benign behavior.
7. “Up to 40 players” is not a useful performance guarantee without CPU allocation, oversubscription, view distance, workload, and tick-rate targets.
8. The public production web application, hosting control plane, desktop launcher, CLI implementation, MCP implementation, build service, and scanner are not present in an identifiable open-source repository.

## What mc-aws should not copy

- Do not promise broad loader/version support without a public tested compatibility matrix.
- Do not deploy generated code directly to a live world without backup verification and disposable testing.
- Do not describe scanner output or signatures as proof that an artifact is safe.
- Do not put infrastructure credentials, Drive tokens, panel API keys, or model keys into prompts.
- Do not make AI the only way to perform an operation.
- Do not build a proprietary source format, asset editor, or model dependency when standard open formats already exist.
- Do not subsidize “free” compute to compete with venture-backed hosting economics.
- Do not add public publishing before moderation, provenance, abuse handling, and revocation exist.

## Historical parity recommendation

Retained for comparison, not an instruction to implement these workstreams before the current agent milestone.

1. Complete the existing CLI, diagnostic bundle, audit log, and typed operations.
2. Add declarative server profiles and immutable content lockfiles.
3. Add safe Modrinth-backed inventory, resolve, stage, test, promote, and rollback workflows.
4. Add live logs, constrained console, player, whitelist, settings, and file administration.
5. Add verified portable backup and automated restore drills.
6. Expose the same contracts through JSON CLI, REST, and OAuth-scoped MCP.
7. Add evidence-linked, model-neutral AI diagnostics and approved remediation.
8. Add prompt-to-source Paper plugins, datapacks, and Fabric server-side mods in that order.
9. Add multi-server/team/provider support and optional crossplay profiles.
10. Consider catalog publishing, desktop play, and creator/community surfaces only after the core is mature.

## Future parity benchmark

This is a possible longer-term benchmark, not the acceptance criteria for the agent foundation.

mc-aws reaches meaningful Orca parity when a user can:

- Select or describe a server change in plain language or conventional UI.
- See the exact resolved Minecraft, Java, loader, artifact, configuration, cost, downtime, and backup plan.
- Build or resolve content reproducibly from pinned inputs.
- Test it in an isolated clone with retained evidence.
- Approve deployment through a typed, policy-checked operation.
- Automatically roll back a failed readiness check.
- Operate the same workflow through web, JSON CLI, and MCP.
- Export source, profiles, lockfiles, backups, and audit records without depending on mc-aws hosting.
- Perform every critical operation without AI.

That would not reproduce all of Orca's consumer marketplace and launcher features, but it would meet the core creation-and-operation outcome with stronger ownership, transparency, and recovery guarantees.
