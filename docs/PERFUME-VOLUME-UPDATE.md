# Millilitre decants and bottle stock counts

This update keeps the existing desktop application identity, database location,
device activation, and invoice history. No customer database, license, local lab
launcher, or test-only activation wrapper is included in the release.

## Existing installations

Create a normal application backup before updating. Existing portion-based lots
are not automatically multiplied or revalued. In the existing stock reconciliation
screen, select the legacy decant lot and explicitly enter the actual millilitres
represented by one old portion. The confirmation shows the conversion. It
preserves the lot's total carrying value and old invoice quantities, and records
the unit conversion in history. Never infer this factor from a perfume's name.

New lots use millilitres. Invoice quantity counts filled bottles, while fill size
determines liquid consumption. The default fill and empty bottle are editable;
each invoice line can use a different fill, subject to bottle capacity and stock.

Count the actual remaining liquid when physically measured. A signed difference
records inventory loss or gain at the lot's carrying cost. Returning the measured
remainder uses the existing return screen and recognizes the difference once.
Neither action changes cash. Reaching zero book stock alone does not assume that
the physical perfume is empty.

## Empty bottles

Use the existing bottle stock count screen and choose a reason explicitly:

- **Breakage / damage:** a physical decrease valued at the authoritative bottle
  cost, included once in inventory loss and net-result reports, with no cash entry.
- **Entry correction:** corrects stock quantity and value without recognizing
  operating profit or loss. An increase is allowed; it is not sales revenue.

Old free-text counts are not retrospectively classified as losses. Editing uses
linked replacement documents and retains the original cost for the same bottle
and warehouse. Later stock quantity changes can prevent editing an absolute
count. Cancellation reverses the count's delta while preserving later sales;
stock-shortage checks still apply. Use the history screen's managed edit/cancel
actions rather than posting a generic adjustment.

Reports distinguish bottles sold from liquid millilitres, and physical bottle
loss from bottle cost already included in cost of goods sold.
