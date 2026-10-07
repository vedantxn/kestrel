import type { Http } from "./http.js";
import type { CallOptions } from "./sessions.js";
import type {
  CreateProfileRequest,
  ListProfilesQuery,
  Page,
  Profile,
} from "./types.js";

const id = (profileId: string) => encodeURIComponent(profileId);

/**
 * `/v1/profiles`: saved browser state (cookies, `localStorage` and IndexedDB of the default
 * context) that sessions start from with `profile: { id }`, and save into with
 * `profile: { id, persist: true }`. Every call answers `400 invalid_request` on a deployment
 * whose operator has not configured profiles.
 */
export class Profiles {
  constructor(private readonly http: Http) {}

  /**
   * Create an empty profile (`version` 0). There is no idempotency key for this call, so it is
   * sent again only when the API answered that it changed nothing; a create that got no answer
   * is not repeated, since it may have made the profile.
   */
  async create(
    req: CreateProfileRequest = {},
    opts: CallOptions = {},
  ): Promise<Profile> {
    return (
      await this.http.request<Profile>("POST", "v1/profiles", {
        body: req,
        signal: opts.signal,
        idempotent: false,
      })
    ).body;
  }

  async get(profileId: string, opts: CallOptions = {}): Promise<Profile> {
    return (
      await this.http.request<Profile>("GET", `v1/profiles/${id(profileId)}`, {
        signal: opts.signal,
      })
    ).body;
  }

  /** Newest first. Pass `nextCursor` back as `cursor` for the next page. */
  async list(
    query: ListProfilesQuery = {},
    opts: CallOptions = {},
  ): Promise<Page<Profile>> {
    return (
      await this.http.request<Page<Profile>>("GET", "v1/profiles", {
        query: { ...query },
        signal: opts.signal,
      })
    ).body;
  }

  /**
   * Delete a profile and every saved version of it. Sessions already running keep their
   * browsers; a session saving into it saves nothing. Deleting it again is `404 not_found`.
   */
  async delete(profileId: string, opts: CallOptions = {}): Promise<void> {
    await this.http.request<undefined>(
      "DELETE",
      `v1/profiles/${id(profileId)}`,
      { signal: opts.signal },
    );
  }
}
