'use strict';

const { verifyToken, COOKIE_NAME } = require('./authService');

// Reads and verifies the session cookie without rejecting the request --
// used both by requireAuth and by routes (like GET /api/centres) that
// behave the same whether or not someone is logged in.
function getUser(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  return verifyToken(token);
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'login required' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'login required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for this role' });
    }
    next();
  };
}

// Farmer-scoped routes (own profile, own status, own J-Form, own
// bookings): a farmer may only ever act as themselves. Any officer or
// operator role passes through unrestricted -- overseeing every farmer is
// their job, not a privilege escalation.
function requireFarmerSelfOrOfficer(getFarmerId) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'login required' });
    if (req.user.role === 'farmer' && getFarmerId(req) !== req.user.farmerId) {
      return res.status(403).json({ status: 'FORBIDDEN', message: 'farmers may only access their own records' });
    }
    next();
  };
}

// Centre-scoped routes (a specific centre's declaration, release-bags,
// lot workflow actions): a centre_officer/operator must be assigned to
// that exact centre; a district_officer must have that centre's district.
// Requires a DB lookup for the district_officer branch, so this is a
// middleware *factory* taking the pool.
function requireCentreScope(pool, getCentreId) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'login required' });
    const centreId = getCentreId(req);

    if (req.user.role === 'centre_officer' || req.user.role === 'operator') {
      if (req.user.centreId !== centreId) {
        return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for this centre' });
      }
      return next();
    }

    if (req.user.role === 'district_officer') {
      try {
        const result = await pool.query('SELECT district FROM centres WHERE id = $1', [centreId]);
        // A centre that doesn't exist at all is left to the route's own
        // 404 -- only a real district mismatch is a 403.
        if (!result.rows[0]) return next();
        if (result.rows[0].district !== req.user.district) {
          return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for this district' });
        }
        return next();
      } catch (err) {
        return next(err);
      }
    }

    return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for this centre' });
  };
}

// Stricter than requireCentreScope: for the one action that must come
// from whoever is physically standing at the centre, not from district
// oversight. Tonight's declaration (gunny stock on hand, hamali gangs
// present, trucks on the yard) is an attestation of ground truth at one
// specific centre -- a district_officer, however genuinely authorized
// for that district, isn't there to see it and submitting on the
// centre's behalf would decouple the declared capacity from what's
// actually on the ground. district_officer keeps read access to the
// same declaration (see requireCentreScope on the GET route) for
// oversight; only the submit is restricted here.
function requireCentreOfficerScope(getCentreId) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'login required' });
    if (req.user.role !== 'centre_officer' || req.user.centreId !== getCentreId(req)) {
      return res.status(403).json({
        status: 'FORBIDDEN',
        message: "only this centre's own officer may submit its declaration",
      });
    }
    return next();
  };
}

// Same idea as requireCentreScope, but for a route keyed by bookingId
// instead of centreId -- looks up the booking's centre first (a missing
// booking is left to the underlying handler's own 404, not turned into a
// 403).
function requireBookingCentreScope(pool) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'login required' });
    if (req.user.role === 'district_officer' || req.user.role === 'centre_officer' || req.user.role === 'operator') {
      try {
        const result = await pool.query(
          `SELECT cd.centre_id, c.district
           FROM bookings b
           JOIN centre_day cd ON cd.id = b.centre_day_id
           JOIN centres c ON c.id = cd.centre_id
           WHERE b.id = $1`,
          [req.params.id]
        );
        if (!result.rows[0]) return next(); // let the route's own NOT_FOUND handling take over

        const { centre_id: centreId, district } = result.rows[0];
        if (req.user.role === 'district_officer') {
          if (district !== req.user.district) {
            return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for this district' });
          }
          return next();
        }
        if (req.user.centreId !== centreId) {
          return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for this centre' });
        }
        return next();
      } catch (err) {
        return next(err);
      }
    }
    return res.status(403).json({ status: 'FORBIDDEN', message: 'not authorized for lot operations' });
  };
}

module.exports = {
  getUser,
  requireAuth,
  requireRole,
  requireFarmerSelfOrOfficer,
  requireCentreScope,
  requireCentreOfficerScope,
  requireBookingCentreScope,
};
