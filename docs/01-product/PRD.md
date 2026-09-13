# AfriLink Product Requirements Document

**Status:** Approved MVP scope - launch parameters and policy decisions remain open  
**Date:** 2026-09-13  
**Product:** AFRILINK  
**Tagline:** Africa's Social Network, Built for Africans.

## 1. Product vision

Build the digital social infrastructure that connects African people, communities, creators, and businesses across borders.

AfriLink should feel African by making country, community, language, culture, and cross-border connection meaningful parts of discovery and participation. It must not be a generic social network with Africa treated as an afterthought.

## 2. Product mission

Help Africans discover trusted people and communities, express themselves, build relationships, and communicate across borders in a safe and privacy-respecting social network.

## 3. Core problem

People across Africa and African diaspora communities need a trusted way to find one another, participate in relevant communities, share experiences, and maintain relationships across country and geographic boundaries. Existing social experiences may be broad but do not necessarily provide African-first discovery, cultural context, country relevance, or a coherent cross-border community experience.

AfriLink must validate which specific initial user problem and market segment create the strongest repeat value. The MVP must therefore prioritize a focused, safe connection experience rather than attempting to serve every possible social use case at once.

## 4. Target users

The MVP is intended for:

- **Individual members:** Africans and members of African diaspora communities who want to connect, share, discover, and communicate.
- **Community participants:** People looking for relevant African communities or groups organized around shared interests, identity, location, or purpose.
- **Creators:** People who publish content and build an audience. Creator-specific needs beyond ordinary publishing require validation.
- **Businesses and organizations:** Representatives who need a presence and relevant discovery. Business-specific functionality beyond profiles and participation is not an MVP commitment.
- **Moderators and administrators:** People responsible for community safety, platform moderation, support, and operations.
- **Unauthenticated visitors:** People who may view permitted public content and decide whether to register.

The initial launch country, countries, diaspora segments, age range, languages, and primary target segment remain open decisions.

## 5. User personas

### Individual member: Amina

Amina wants to find people and communities connected to her country, interests, and wider African identity. She needs a trustworthy profile, relevant discovery, a useful feed, and clear privacy controls.

### Cross-border connector: Kwame

Kwame maintains relationships across countries. He needs to discover people and communities beyond his immediate location, communicate reliably, and control who can see or contact him.

### Creator: Zuri

Zuri publishes text, photos, and videos and wants people interested in her work to find and follow her. She needs understandable visibility, engagement, reporting, and account safety controls. Monetization is out of scope.

### Community participant and moderator: Thabo

Thabo joins communities for shared interests and may help manage one. He needs clear membership rules, scoped community roles, reporting, and tools to keep the community safe without receiving platform-wide authority.

### Platform moderator or administrator: Nia

Nia reviews reports, applies policy consistently, handles appeals where applicable, and protects users. She needs scoped access, auditability, privacy-aware case information, and a clear operational workflow.

## 6. MVP objectives

The MVP must:

1. Enable people to create and secure an AfriLink account.
2. Give users a meaningful identity through profiles, country context, and privacy controls.
3. Enable trusted social connection through friends, following, blocking, and discovery.
4. Enable expression and participation through text, photo, and video posts, reactions, comments, and shares.
5. Provide a useful home feed and relevant African and country-based discovery.
6. Enable safe direct communication and timely notifications.
7. Enable communities with scoped roles and basic community governance.
8. Provide reporting, blocking, moderation, and administration before public launch.
9. Establish measurable evidence of activation, retention, connection, engagement, and safety.

## 7. MVP success criteria

Success measures must be finalized for the selected launch market before launch. The MVP should measure:

- **Activation:** registration completion, verification completion, profile completion, first follow/friend action, first community join, first post, and first meaningful interaction.
- **Retention:** returning users by week and month, segmented by country, language, and user type where appropriate.
- **Connection:** accepted friend relationships, follows, community joins, meaningful conversations, and cross-border connections.
- **Engagement:** feed consumption, posts, comments, reactions, shares, messages, and notification interactions.
- **Discovery:** searches, profile/community views, country discovery use, and successful discovery actions.
- **Safety:** report rate, moderation response time, repeat-abuse rate, blocked-contact attempts, action outcomes, and appeal outcomes.
- **Reliability:** sign-in success, feed availability, message delivery, notification delivery, media upload success, crash-free sessions, and service availability.
- **Experience:** user-reported trust, relevance of discovery, usability, accessibility, and low-bandwidth experience.

Specific numeric targets, measurement definitions, baseline period, and launch thresholds are open questions and must be approved before implementation is considered complete.

## 8. MVP scope

The MVP includes account registration, login/logout, verification, password reset, user profiles, friends, following, news feed, text/photo/video posts, reactions, comments, shares, messaging, notifications, search, communities/groups, country-based discovery, reporting, blocking, basic moderation, an admin dashboard, and privacy controls.

The requirements below define the intended product behavior without prescribing technical implementation.

## 9. Out-of-scope features

The following are explicitly outside the MVP unless separately approved:

- Marketplace and commerce.
- Payments, remittances, lending, or financial services.
- Jobs and recruitment.
- Advanced creator monetization.
- Live streaming, live audio rooms, and similar real-time broadcast features.
- Stories and other additional content formats not listed in the MVP scope.
- Public third-party developer APIs.
- Complex opaque recommendation or personalization systems.
- Any feature that changes the approved MVP boundaries without product approval.

## 10. User registration

AfriLink must:

- Allow a new user to create an account using an approved identity method.
- Validate required registration information and prevent duplicate or abusive registration where policy requires.
- Apply verification and abuse controls during onboarding.
- Establish an account state and provide clear next steps when verification is incomplete.
- Collect only information required for registration, safety, personalization, and legal obligations.
- Support a first-run flow for display identity, country or region, language preferences, privacy defaults, and relevant discovery choices.
- Avoid exposing whether a private account or credential exists when that would enable enumeration.

The approved identity methods, required fields, supported countries, age policy, and verification channels remain open decisions.

## 11. Authentication

AfriLink must support:

- Login and logout.
- Account verification.
- Password reset and account recovery.
- Session management and revocation.
- Protection against credential abuse, automated login, and unauthorized access.
- Clear account states including active, restricted, suspended, and deleted where applicable.
- Appropriate re-authentication for sensitive account, privacy, and administrative actions.

Authentication behavior must follow the authentication design already established in `CLAUDE.md`; this PRD does not redefine its implementation.

## 12. User profiles

Users must be able to create and manage a profile containing an appropriate subset of:

- Display name and public identifier.
- Profile photo.
- Biography or introduction.
- Country, region, or location context.
- Language preferences.
- Interests where approved for discovery.
- Privacy and discoverability settings.

Users must be able to view profiles only to the extent permitted by account status, visibility, relationship, block, and moderation rules. Profiles must support safe public identity without exposing private account information.

## 13. Friend/follow system

AfriLink must support both friendship and following as distinct relationship concepts, subject to final product semantics:

- Users can send, accept, decline, remove, and view permitted friend relationships.
- Users can follow and unfollow other users.
- Users can see their relationship state with another user when permitted.
- Relationship actions must respect privacy, blocks, account restrictions, and moderation.
- Users must not be able to bypass a block or privacy setting through followers, friends, search, feed, notifications, or messaging.
- Relationship changes should produce appropriate notifications according to preferences.

The exact distinction between friends and followers, including whether friendship is mutual and how each affects visibility and messaging, must be finalized before implementation.

## 14. Home feed

The home feed must:

- Present eligible content from permitted connections, communities, and other approved discovery sources.
- Respect account status, privacy, blocks, moderation actions, and content visibility.
- Support text, photo, and video posts in a clear chronological or approved relevance order.
- Support pagination and useful empty, loading, failure, and restricted-content states.
- Provide enough relevance to help a new user find value without relying on opaque personalization.
- Support user controls such as hiding or reporting content where approved.

The initial ranking model, feed freshness target, and cold-start behavior require product approval.

## 15. Posts

Users must be able to:

- Create text posts.
- Create photo posts.
- Create video posts.
- Select an allowed audience or visibility level.
- Publish to their profile or an eligible community.
- Edit or delete their own posts according to the approved policy.
- View engagement associated with posts where permitted.
- Report posts they believe violate policy.

Posts must pass applicable account, visibility, media, community, and moderation rules. The MVP does not include unapproved additional post formats.

## 16. Reactions

Users must be able to apply and remove an approved reaction to eligible posts and comments. The product must:

- Make the current user’s reaction state clear.
- Prevent duplicate or contradictory reaction state beyond the approved reaction model.
- Respect visibility, blocks, moderation, and deleted content.
- Show engagement counts only where the viewer is authorized to see them.
- Notify authors according to notification preferences and aggregation rules.

The reaction set and whether users may select one or multiple reaction types require confirmation.

## 17. Comments

Users must be able to:

- Add comments to eligible posts.
- View comments they are permitted to see.
- Edit or delete their own comments according to policy.
- Report comments.
- Apply approved reactions to comments.

Comments must respect post visibility, community permissions, blocks, account state, and moderation actions. Threading depth, mentions, comment limits, and ordering remain open product decisions.

## 18. Sharing

Users must be able to share eligible posts within AfriLink according to the post owner’s visibility settings and applicable privacy rules. Sharing must:

- Preserve the original author and source context.
- Prevent access to content the recipient is not permitted to view.
- Respect blocks, deleted content, moderation actions, and community restrictions.
- Allow the product to apply reporting and moderation to the shared representation.

External sharing, quote-post behavior, and resharing commentary are not defined and require approval before inclusion.

## 19. Messaging

AfriLink must support safe direct messaging, including:

- One-to-one conversations.
- Approved small-group conversations if included in the launch scope.
- Sending and receiving text messages.
- Message history and delivery/read state appropriate to the product policy.
- Approved media attachments where media requirements permit them.
- Blocking, reporting, muting, and leaving conversations where applicable.
- Recovery after intermittent connectivity and clear send failure states.

Messaging must enforce relationship, privacy, membership, account, moderation, and block rules. Message retention, group size, attachment types, read receipts, and who may initiate conversations require final policy decisions.

## 20. Notifications

AfriLink must provide in-app notifications for relevant activity such as relationships, posts, comments, reactions, shares, community events, messages, verification, and moderation outcomes where appropriate.

Users must be able to:

- View and mark notifications as read.
- Configure notification preferences by supported category and channel.
- Receive notifications only when permitted by privacy, consent, blocking, quiet-hour, and account rules.
- Avoid excessive duplicate notifications through grouping or aggregation.

Push, email, and SMS channels are subject to product consent, provider, and launch-scope decisions. Sensitive message content must not be exposed in notifications by default.

## 21. Search

Users must be able to search eligible:

- People and profiles.
- Communities/groups.
- Public posts or other approved public content.

Search must:

- Apply visibility, account, block, moderation, and deletion rules before showing results.
- Support relevant country, language, and community context where approved.
- Provide useful empty and no-access states without revealing private records.
- Apply safe limits and abuse controls.

Search ranking, supported languages, filters, and whether private or follower-only content is searchable require approval.

## 22. Discover

Discover must help users find relevant people, communities, and content beyond their existing relationships. It should prioritize African context, country relevance, shared interests, communities, and cross-border connection where those signals are available and appropriate.

Discover must be transparent enough for users to understand why content or accounts are shown, respect privacy and safety controls, and avoid opaque personalization in the MVP.

The exact discover surfaces, ranking signals, and onboarding recommendations require validation.

## 23. Country-based discovery

AfriLink must make country-based discovery a first-class MVP capability:

- Users can identify their country or relevant country context in their profile, subject to privacy controls.
- Users can discover eligible people, communities, and content associated with a country or region.
- Country discovery must support cross-border exploration rather than restricting users to their current country.
- Country information must not expose sensitive location data or imply verification unless the product explicitly supports it.
- Country-based results must respect language, privacy, blocks, moderation, and account status.

The initial country list, region granularity, country verification policy, and supported languages are open decisions.

## 24. Communities

Users must be able to:

- Discover eligible communities/groups.
- Create a community where permitted.
- View community information and rules before joining or participating.
- Join, request membership, leave, or be removed according to community policy.
- Participate in community posts and discussions.
- Report community content, members, or the community itself.

Communities may be public or private according to the approved MVP model. Community visibility and membership must not leak through search, feeds, notifications, or errors.

## 25. Community roles

Communities must support scoped roles appropriate to their size and policy, including at minimum an owner and moderators where moderation is enabled. Roles must:

- Be limited to the relevant community.
- Support membership and content management appropriate to the role.
- Be auditable and removable.
- Never grant platform-wide administrator authority.
- Respect platform sanctions and escalation to platform moderation.

The exact role names, permissions, approval workflow, and maximum community size require confirmation.

## 26. Reporting

Users must be able to report eligible:

- Profiles.
- Posts, comments, and shared content.
- Messages or conversations.
- Communities and community activity.

Reports must provide a clear reason category, optional supporting context where approved, confirmation that the report was received, and appropriate status visibility. Reporting must avoid exposing reporter identity or sensitive case details unnecessarily.

The report taxonomy, anonymous-report policy, duplicate handling, and user feedback commitments require approval.

## 27. Blocking

Users must be able to block and unblock other users. Blocking must suppress or restrict the blocked relationship across the product, including as applicable:

- Profile discovery.
- Feed and search results.
- Messaging and conversation initiation.
- Notifications.
- Follows, friends, comments, mentions, and community interactions.

The product must define exceptions required for safety, legal holds, or moderation. Block state must be applied consistently and must not be bypassable through alternate identifiers or shared content.

## 28. Moderation

AfriLink must provide basic platform and community moderation for the first public MVP. Moderation must include:

- Review of reports and policy signals.
- Categorized cases with priority and status.
- Actions proportionate to the violation, including content action and account or community restrictions where approved.
- Evidence access limited to authorized roles.
- User communication appropriate to the decision.
- Appeals where policy requires them.
- Auditability of decisions, actors, reasons, scope, and duration.

Automated checks may assist triage, but consequential enforcement must follow the approved moderation policy. The policy, service levels, sanctions, appeals, and legal escalation path are open decisions.

## 29. Admin dashboard

The MVP admin dashboard must provide authorized platform operators with:

- Moderation case and report review.
- User, profile, content, community, and account-status lookup appropriate to role.
- Sanction and moderation action management.
- Appeal handling where applicable.
- Basic platform and provider health visibility.
- Audited administrative actions.

Admin access must be scoped by least privilege, protected by stronger authentication, and separated from community roles. The dashboard must not expose secrets or permit arbitrary production data manipulation.

The exact admin roles, operational metrics, and support workflows require approval.

## 30. Settings and privacy

Users must be able to manage:

- Profile and account settings.
- Privacy and discoverability defaults.
- Who may follow, friend, message, or interact with them where supported.
- Notification preferences.
- Language, country/region, timezone, and accessibility preferences where supported.
- Blocked users.
- Session or device access where supported.
- Account deletion or deactivation request.

Privacy controls must be understandable, apply consistently across the product, and default to appropriate protection for new users. Data export, consent management, and legal rights workflows require product and legal definition.

## 31. Media requirements

The MVP must support photo and video posts and approved media in other MVP contexts. Media must:

- Be uploaded only by an authorized user for an approved purpose.
- Support allowed file types, sizes, dimensions, duration, and quotas.
- Be validated before appearing as approved content.
- Support processing suitable for web, mobile, and variable connectivity.
- Avoid exposing private storage details or unauthorized media.
- Support deletion and cleanup according to content and retention policy.
- Preserve appropriate attribution and accessibility information such as alternative text where supported.

Exact file limits, video duration, processing targets, media safety checks, and storage retention require approval.

## 32. Performance requirements

AfriLink must provide a responsive experience for supported devices and variable African network conditions. Product requirements include:

- Efficient feed, search, profile, community, notification, and message loading.
- Useful loading, retry, empty, offline, and degraded states.
- Pagination for potentially large collections.
- Efficient media delivery and upload behavior.
- Predictable message and notification delivery behavior.
- Monitoring of latency, error rate, upload success, queue delay, and availability.

Numeric API latency, feed freshness, message delivery, upload completion, availability, device support, bandwidth budgets, and recovery targets are not yet approved and must be defined before launch.

## 33. Accessibility

The MVP must:

- Support keyboard navigation where applicable.
- Use semantic controls and meaningful labels.
- Provide readable contrast and visible focus states.
- Support assistive technologies for core journeys.
- Provide accessible validation, loading, error, and moderation states.
- Avoid making color, media, sound, or motion the only way to understand important information.
- Provide alternative text or equivalent context for user media where supported.

The target accessibility standard and testing threshold require confirmation.

## 34. Security requirements

AfriLink must:

- Protect passwords, tokens, API secrets, and private user information.
- Validate all untrusted input and uploaded media.
- Enforce server-side authentication, authorization, and resource-level access checks.
- Protect against account takeover, enumeration, abuse, injection, XSS, CSRF where applicable, IDOR, privilege escalation, and file-upload abuse.
- Apply rate limits to authentication, verification, recovery, posting, messaging, reporting, search, media, and admin actions.
- Protect administrator accounts with stronger authentication and audit sensitive actions.
- Avoid exposing sensitive data in logs, notifications, analytics, errors, or public URLs.
- Support security testing, dependency review, incident response, and access review before release.

The implementation must follow the security constraints in `CLAUDE.md`; this PRD defines the product obligation rather than the technical design.

## 35. Privacy requirements

AfriLink must:

- Collect and expose only information necessary for the user experience, safety, operations, or legal obligations.
- Give users understandable control over profile, content, relationship, messaging, discovery, and notification visibility.
- Apply privacy, block, moderation, and account-state rules consistently across feeds, search, discover, notifications, messaging, and communities.
- Define account deletion, content deletion, retention, evidence preservation, and backup behavior.
- Protect sensitive content and personal information in admin, moderation, analytics, logs, and support workflows.
- Document country and cross-border data handling before launch.
- Provide consent and user-rights workflows required by the launch markets.

Retention periods, data residency, legal basis, export, correction, and deletion guarantees remain open decisions.

## 36. Analytics

AfriLink must measure product health without collecting unnecessary personal information. Analytics must cover:

- Registration and onboarding completion.
- Profile completion and first meaningful action.
- Discovery, country browsing, follows, friendships, community joins, posts, reactions, comments, shares, messaging, and notifications.
- Retention and engagement by approved market, country, language, and user type where privacy-preserving.
- Reports, moderation response, sanctions, appeals, and safety outcomes.
- Reliability, performance, media, notification, and message delivery outcomes.

Analytics events must have defined names, ownership, purpose, retention, access controls, and privacy treatment. The final event taxonomy and tooling require approval.

## 37. Core user journeys

### Registration and onboarding

1. A visitor starts registration.
2. AfriLink validates the registration and applies abuse controls.
3. The user completes required verification.
4. The user sets identity, country/region, language, and privacy defaults.
5. AfriLink offers relevant people or communities to discover.
6. The user completes a meaningful first action.

### Discovering and connecting

1. A user searches, browses Discover, or explores a country.
2. The user opens an eligible profile or community.
3. The user follows, sends a friend request, joins, or starts an allowed conversation.
4. AfriLink applies privacy, block, and moderation rules.
5. The recipient receives an appropriate notification.

### Publishing and engaging

1. A user creates text, photo, or video content.
2. AfriLink validates audience, media, permissions, and policy.
3. The content is published if accepted.
4. Eligible users see it in feeds or discovery.
5. Users react, comment, share, or report according to permission.

### Participating in a community

1. A user finds a community.
2. The user reviews its visibility, rules, and membership conditions.
3. The user joins or requests membership.
4. The user participates in permitted community activity.
5. Community roles manage local issues and escalate serious issues to platform moderation.

### Messaging safely

1. A user starts or accepts an allowed conversation.
2. AfriLink checks privacy, relationship, block, membership, and moderation rules.
3. The user sends or receives messages.
4. The user can mute, block, report, or leave as permitted.

### Reporting and moderation

1. A user reports a profile, content, message, or community.
2. AfriLink confirms receipt without exposing sensitive case information.
3. An authorized moderator reviews the case.
4. AfriLink applies and records a proportionate action.
5. The affected user receives an appropriate explanation and appeal path where required.

## 38. User stories

- As a new user, I want to register and verify my account so that I can participate safely.
- As a user, I want to recover access to my account so that I do not lose my identity and relationships.
- As a user, I want to create a profile with country and language context so that relevant people can find me.
- As a user, I want to control who can see or contact me so that I can participate with confidence.
- As a user, I want to find African people, communities, and content so that the network is relevant to me.
- As a user, I want to explore another country so that I can build cross-border connections.
- As a user, I want to follow or befriend people so that I can maintain different kinds of relationships.
- As a user, I want to publish text, photos, and videos so that I can express myself.
- As a user, I want to react, comment, and share eligible posts so that I can participate in conversations.
- As a user, I want a useful feed so that I can keep up with relevant activity.
- As a user, I want to message permitted people or groups so that I can communicate privately.
- As a user, I want notifications I can control so that I know about important activity without being overwhelmed.
- As a user, I want to join and participate in communities so that I can connect around shared interests.
- As a community owner or moderator, I want scoped controls so that I can manage my community without platform-wide authority.
- As a user, I want to report harmful content or behavior so that the platform can respond.
- As a user, I want to block someone so that they cannot continue unwanted interaction.
- As a moderator, I want reports, cases, actions, and appeals to be auditable so that enforcement is consistent.
- As an administrator, I want a secure dashboard so that I can operate the platform without exposing secrets or private data unnecessarily.

## 39. Feature priorities

### Priority 0: required foundation

- Registration, login/logout, verification, password reset, account states, and privacy defaults.
- Profiles, authorization, blocking, reporting, basic moderation, and administrator access controls.

### Priority 1: core social value

- Friends, following, home feed, text/photo/video posts, reactions, comments, shares, messaging, and notifications.

### Priority 2: AfriLink differentiation and participation

- Search, Discover, country-based discovery, communities/groups, and scoped community roles.

All Priority 0 and Priority 1 items are required for the MVP. Priority 2 is also part of the approved MVP scope, but its release sequencing may be adjusted only through product approval. No priority change may remove an approved MVP requirement silently.

## 40. MVP definition of done

The AfriLink MVP is complete only when:

- Every in-scope feature has approved acceptance criteria and an accountable owner.
- Registration, authentication, profiles, social relationships, feed, posts, engagement, messaging, notifications, search, Discover, country discovery, communities, safety, admin, media, settings, privacy, and analytics journeys are usable end to end.
- Privacy, block, moderation, and account-state rules are enforced consistently across all relevant user journeys.
- Text, photo, and video content flows work with approved limits and safety handling.
- Reporting, moderation actions, auditability, and required appeals are operational.
- Security, privacy, accessibility, performance, reliability, and low-bandwidth requirements have approved measurable thresholds and evidence.
- Core analytics events and success measures are implemented and privacy-reviewed.
- Unit, integration, API, end-to-end, and security coverage appropriate to the risk is complete.
- Backups, recovery, monitoring, support, moderation, and incident-response processes are ready for the launch market.
- Product owners approve the release against the selected market, policy, and success criteria.

## 41. Future product expansion

Future expansion may be considered after MVP validation and explicit approval. Candidates include deeper creator and business experiences, advanced discovery, additional content formats, monetization, commerce, jobs, financial services, live experiences, and broader platform integrations.

These are possibilities, not commitments. Expansion must follow evidence from user needs, safety outcomes, operating capacity, and the approved product strategy. Marketplace, payments, jobs, advanced creator monetization, and live streaming remain explicitly out of scope for the MVP.

## Open product decisions

The following decisions must be resolved before requirements are treated as implementation-ready:

- Initial launch country or countries, target segment, diaspora scope, and launch sequence.
- Supported languages, age policy, accessibility target, and identity/verification methods.
- Exact friend/follow semantics, visibility modes, messaging permissions, and community model.
- Feed and Discover ranking, cold-start behavior, reaction set, sharing behavior, and content limits.
- Moderation taxonomy, sanctions, appeals, legal escalation, response targets, and evidence retention.
- Privacy, consent, deletion, export, retention, residency, and cross-border data policies.
- Numeric success targets, performance thresholds, reliability objectives, capacity assumptions, and launch criteria.