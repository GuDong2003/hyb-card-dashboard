# VIP-aware paid and free pull columns

## Goal

Split the user overview's derived pull count into paid pulls and free pulls, then calculate legendary probability from their sum. Only current-period users with both the epic and spend leaderboard entries are eligible for derived calculations.

## Calculation

- Paid pulls = spend USD / 10.
- VIP users use 600 paid pulls/day and 50 free pulls/day.
- Ordinary users use 400 paid pulls/day and 30 free pulls/day.
- Effective pull days = ceil(paid pulls / daily paid limit).
- Free pulls = effective pull days × daily free quota.
- Total pulls = paid pulls + free pulls.
- Legendary probability = legendary card count / total pulls.

The minimum reliable sample is one full paid day: $6,000 for VIP and $4,000 for ordinary users. Below the user's own threshold, derived fields remain blank while raw spend and legendary values remain visible.

## Data eligibility

For the selected period, epic and spend rows must both come from the current snapshot batch (same season, scope, and capture bucket). Historical metrics are retained for trends but are not used to calculate current rows. Users missing either current board are marked incomplete and keep raw fields only.

## Presentation

The users table exposes separate columns for paid pulls and free pulls. The existing pulls trend metric maps to total pulls. Status text identifies missing pairs or insufficient samples.

## Verification

Tests cover VIP and ordinary formulas, partial samples, current-batch matching, missing board fields, probability denominators, and table headers.
