// backend.js — which backend this build talks to.
//
//   supabase (default)  today: Supabase Auth + Supabase's PostgREST.
//   gcp                 Google Cloud: our API signs people in (lib/gcpAuth.js)
//                       and our own PostgREST serves /rest/v1 on the same origin.
//                       Set at build time: VITE_BACKEND=gcp (deploy/gcp/cloudbuild.yaml).
//
// GCP is a plain comparison on the build-time value, so the bundler can tell it
// is false in a Supabase build and leave the Google Cloud sign-in code out.
export const GCP = import.meta.env.VITE_BACKEND === "gcp";
export const BACKEND = GCP ? "gcp" : "supabase";
