// TM-8b — Saved searches + "candidates like this" + new-applicant alerts.
//
// Deferred from the 8a dispatch (operator-preferred split: 8a applicant-tracking
// merges first; 8b ships separately). Persistence needs a SavedSearch table with
// per-hirer RLS plus an alert-fanout worker — both out of TM-8's no-schema-change
// scope. This service is wired so the lane file ownership and route contract are
// stable; methods surface 501 until TM-8b lands. Follow-up issue: TM-8b.
import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class SavedSearchService {
  // TODO(TM-8b): persist a per-hirer SavedSearch (query JSON + alert opt-in) and
  // back the "candidates like this" similarity read off the existing fit signal.
  list(): never {
    throw this.deferred();
  }

  create(): never {
    throw this.deferred();
  }

  private deferred(): NotImplementedException {
    return new NotImplementedException({
      error: 'Not Implemented',
      message: 'Saved searches ship in TM-8b.',
      code: 'SAVED_SEARCH_NOT_AVAILABLE',
    });
  }
}
