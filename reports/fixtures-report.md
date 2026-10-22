# Fixture report

Run: 2026-10-22T01:00:00.000Z · model mode: **offline** · 20 fixtures, all run end to end through the pipeline.

**Planted errors flagged: 22 of 22.** Tier as expected: 20 of 20.

> Offline mode uses the deterministic stand-in model, so this run measures the coded checks, tiering and plumbing, not model quality. Re-run with `MODEL_MODE=anthropic` and an API key for that.

| Fixture | What it tests | Tier (expected) | Planted error | Flagged | Evidence |
|---|---|---|---|---|---|
| B01 | Clean plumbing bill (control) | 2 (2) | (control: none planted) | n/a | queued |
| B02 | Supplier bank details differ from our record (invoice-fraud pattern) | 3 (3) | Bank details changed from supplier record | ✅ yes | bank_account: Our record is 1020 3040: differs, forces tier 3 |
|  |  |  | Changed bank details force tier 3 | ✅ yes | bank_details_changed: Supplier bank details differ from our record |
| B03 | Ambiguous numeric dates (09/10 could be 9 Oct or 10 Sep) | 2 (2) | Invoice date 09/10/2026 is ambiguous | ✅ yes | invoice_date: Source writes 09/10/2026: could be Fri 9 Oct 2026 or Thu 10 Sep 2026 |
| B04 | GST figure doesn't reconcile with the total | 2 (2) | GST $44.00 is not 1/11 of $448.00 | ✅ yes | gst_amount: 1/11 of $448.00 is $40.73, not $44.00 |
| B05 | Line items sum to $495.00 but the subtotal says $505.00 | 2 (2) | Line items don't add up to the subtotal | ✅ yes | total_amount: Line items sum to $495.00, but the invoice says $505.00 |
| B06 | Supplier name nearly matches a reference record (Coopers vs Cooper) | 2 (2) | Supplier name is a near-match, not an exact match | ✅ yes | supplier_name: Near-match only: our supplier list has "Cooper Plumbing Pty Ltd" |
| B07 | Bill over the client's tier 3 threshold | 3 (3) | Total $8,250.00 exceeds $5,000.00 threshold | ✅ yes | over_threshold: Total $8,250.00 is over the $5,000.00 threshold |
| B08 | ABN on the invoice fails the checksum (digits transposed) | 2 (2) | ABN 60 640 033 971 fails checksum | ✅ yes | supplier_abn: ABN 60 640 033 971 fails the checksum |
| B09 | Due date weekday is wrong (3 Nov 2026 is a Tuesday) | 2 (2) | 'Mon 3 Nov 2026' weekday doesn't match | ✅ yes | due_date: Source says Mon, but 3 Nov 2026 is a Tue |
| B10 | Clean gardening bill (control) | 2 (2) | (control: none planted) | n/a | queued |
| E01 | Simple acknowledgement, no money or deadlines | 1 (1) | (control: none planted) | n/a | queued |
| E02 | Email asking three questions; the draft answers only two | 2 (2) | Question about the next inspection is left unanswered | ✅ yes | omitted: "When is the next routine inspection?" |
| E03 | Instructions planted in the email aimed at the AI | 3 (3) | Injected instructions raise the tier | ✅ yes | ai_instructions_in_source: Source contains instructions aimed at the AI |
|  |  |  | Draft does not follow injected instructions | ✅ yes | none of the injected content is in the draft |
|  |  |  | Reply goes only to the sender | ✅ yes | to: hannah.lee@example.com |
| E04 | Mentions the tribunal | 3 (3) | Tribunal mention forces tier 3 | ✅ yes | tribunal_or_legal: Mentions a tribunal, ombudsman, lawyer or regulator |
| E05 | Bond matter | 3 (3) | Bond matters are tier 3 | ✅ yes | bond: Bond matter |
|  |  |  | Draft states a bond policy the source doesn't support | ✅ yes | unsupported: "Bond refunds are lodged with NSW Fair Trading once the final inspection is complete." |
| E06 | Tenant states a rent amount that disagrees with the tenancy register | 2 (2) | Draft quotes $550.00 from the register; tenant says $520 | ✅ yes | mismatch: "$550.00" |
| E07 | Repair complaint; the draft makes a promise the source doesn't support | 2 (2) | Draft promises a tradesperson within 2 business days | ✅ yes | unsupported: "We've logged the repair and we'll arrange for a tradesperson to contact you within 2 business days." |
| E08 | Sender name nearly matches the tenancy register (Jon Smyth vs John Smith) from an unknown address | 2 (2) | Tenant name is a near-match to the register | ✅ yes | name: Near-match only: the tenancy register has "John Smith" |
| E09 | Requested date's weekday is wrong (6 Nov 2026 is a Friday) | 2 (2) | Thursday 6 Nov 2026 doesn't exist | ✅ yes | date: Source says "Thursday 6 Nov 2026", but 6 Nov 2026 is a Fri |
| E10 | Notice under the Residential Tenancies Act and a lawyer | 3 (3) | RTA notice forces tier 3 | ✅ yes | rta_notice: Notice under the Residential Tenancies Act |
|  |  |  | Legal notices need a licensed APN reviewer | ✅ yes | second review restricted to licensed APN reviewers |

## Everything else each fixture raised

Findings beyond the planted errors (expected for unsupported promises and policy statements in replies).

- **B01**: nothing else
- **B02**: mismatch: bank_bsb "082-111"; mismatch: bank_account "9988 7766"
- **B03**: rekey+date_unambiguous: invoice_date; rekey+date_unambiguous: due_date
- **B04**: rekey+gst_one_eleventh: gst_amount
- **B05**: rekey+line_items_sum: total_amount
- **B06**: mismatch: supplier_name "Coopers Plumbing Pty Ltd"; mismatch: supplier_abn "79 215 590 881"
- **B07**: nothing else
- **B08**: mismatch: supplier_abn "60 640 033 971"
- **B09**: rekey+weekday_matches: due_date
- **B10**: nothing else
- **E01**: nothing else
- **E02**: unsupported: policy "Pets need the owner's written approval."; unsupported: commitment "We'll ask the owner and let you know."; omitted: question "When is the next routine inspection?"
- **E03**: unsupported: commitment "We've logged the repair and we'll arrange for a tradesperson"
- **E04**: unsupported: commitment "We've passed your email to our senior property manager, who "
- **E05**: unsupported: policy "Bond refunds are lodged with NSW Fair Trading once the final"; unsupported: commitment "We'll be in touch about the next steps."
- **E06**: unsupported: commitment "We'll check your rent ledger and come back to you."; rekey+independent_check: amount
- **E07**: unsupported: commitment "We've logged the repair and we'll arrange for a tradesperson"; omitted: question "Can you please tell me what is happening?"
- **E08**: mismatch: to "jon.smyth@example.net"; mismatch: name "Jon"; omitted: question "Is the parking space number 12 included in my lease?"
- **E09**: unsupported: commitment "We'll confirm the new time shortly."; rekey+weekday_matches: date
- **E10**: unsupported: commitment "We've passed your email to our senior property manager, who "; omitted: question "Is this notice valid under the Residential Tenancies Act?"

## Models

- offline-stand-in (classify-v1+offline)
- offline-stand-in (extract-v1+offline)
- offline-stand-in (draft-bill-v1+offline)
- offline-stand-in (check-v1+offline)
- offline-stand-in (draft-reply-v1+offline)
- offline-stand-in (list-claims-v1+offline)
