/**
 * supabase-client.js — Supabase connection singleton
 */

const SUPABASE_URL  = 'https://ptcvgmqvwwosuakvopyg.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0Y3ZnbXF2d3dvc3Vha3ZvcHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDg1MDksImV4cCI6MjA5ODg4NDUwOX0.vw9vLfcp554ictCfs72F6zxmhs3oY7kz6zEKKGZ5Dn8';

// Supabase JS v2 loaded via CDN (added to HTML pages)
let _sb = null;

function getSupabase() {
  if (_sb) return _sb;
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    throw new Error('Supabase JS SDK not loaded. Add the CDN script before this file.');
  }
  _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  return _sb;
}
