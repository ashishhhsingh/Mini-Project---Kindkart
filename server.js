// server.js (ready-to-use) — compatible with your frontend variants
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ensure uploads folder exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Multer config for file uploads (photo)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `photo_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Only JPG/PNG files are allowed'));
  }
});

// Middleware
app.use(cors()); // adjust origin/options if needed
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

// MySQL connection — update credentials as needed
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '123456',
  database: 'mini_project'
});

db.connect(err => {
  if (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Connected to MySQL database');
});

/* ----------------------------
   Routes (signup, login, donations, profile, etc.)
   ---------------------------- */

// Signup
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });

  const sql = 'INSERT INTO users (name, email, password) VALUES (?, ?, ?)';
  db.query(sql, [name, email, password], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already registered' });
      console.error('Signup DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ message: 'Signup successful', user: { id: result.insertId, name, email } });
  });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const sql = 'SELECT * FROM users WHERE email = ?';
  db.query(sql, [email], (err, results) => {
    if (err) {
      console.error('Login DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (results.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = results[0];
    if (password !== user.password) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ message: 'Login successful', user: { id: user.id, name: user.name, email: user.email, phone: user.phone || null, photo_url: user.photo_url || null } });
  });
});

// Process Donation (direct money)
app.post('/api/payments/process', (req, res) => {
  const { amount, paymentMethod, currency, description, donorInfo } = req.body;
  if (!amount || !paymentMethod || !donorInfo) return res.status(400).json({ error: 'Invalid request data' });

  const transactionId = uuidv4();
  const sql = `
    INSERT INTO donations 
    (transactionId, userId, firstName, lastName, email, amount, paymentMethod, currency, description, createdAt) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  db.query(sql, [
    transactionId,
    donorInfo.userId || null,
    donorInfo.firstName || null,
    donorInfo.lastName || null,
    donorInfo.email || null,
    amount,
    paymentMethod,
    currency || 'INR',
    description || null
  ], (err) => {
    if (err) {
      console.error('payments/process DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, transactionId, message: 'Donation successful' });
  });
});

// Checkout donation with cart items
app.post('/api/checkout', (req, res) => {
  const { userId, items, amount, paymentMethod, currency, description } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'No items in cart' });

  const transactionId = uuidv4();
  const donationSql = `
    INSERT INTO donations 
    (transactionId, userId, email, amount, paymentMethod, currency, description, createdAt) 
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  db.query(donationSql, [
    transactionId, userId || null, null,
    amount, paymentMethod || 'card', currency || 'INR', description || 'Cart donation'
  ], (err, result) => {
    if (err) {
      console.error('checkout donation insert error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const donationId = result.insertId;
    const itemSql = `INSERT INTO donation_items (donationId, userId, itemName, price, qty) VALUES ?`;
    const values = items.map(i => [donationId, userId, i.name, i.price, i.qty || 1]);

    db.query(itemSql, [values], (err2) => {
      if (err2) {
        console.error('checkout donation_items insert error:', err2);
        return res.status(500).json({ error: 'Failed to save donation items' });
      }
      res.json({ success: true, transactionId, donationId, amount, items });
    });
  });
});

// Donations summary
app.get('/api/users/:userId/donations/summary', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT d.id, d.transactionId, d.amount, d.createdAt, 
           'Kind-Kart' AS donatedTo
    FROM donations d
    WHERE d.userId = ?
    ORDER BY d.createdAt DESC
  `;
  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error('donations summary error:', err);
      return res.status(500).json({ error: 'Error fetching donation summary' });
    }
    res.json({ donations: rows });
  });
});

// Donation details
app.get('/api/donations/:id/details', (req, res) => {
  const { id } = req.params;

  const donationSql = `
    SELECT d.id, d.transactionId, d.amount, d.paymentMethod, d.currency,
           d.description, d.createdAt, 
           COALESCE(u.name, d.firstName, 'Anonymous') AS userName,
           u.email AS userEmail
    FROM donations d
    LEFT JOIN users u ON d.userId = u.id
    WHERE d.id = ?
  `;

  const itemsSql = `SELECT itemName, price, qty, createdAt FROM donation_items WHERE donationId = ?`;

  db.query(donationSql, [id], (err, donationRows) => {
    if (err || donationRows.length === 0) {
      console.error('donation details error or not found:', err);
      return res.status(404).json({ error: 'Donation not found' });
    }

    const donation = donationRows[0];
    db.query(itemsSql, [id], (err2, itemRows) => {
      if (err2) {
        console.error('donation items error:', err2);
        return res.status(500).json({ error: 'Error fetching donation items' });
      }
      donation.type = itemRows.length > 0 ? 'Cart Donation' : 'Direct Money Donation';
      donation.items = itemRows;
      res.json({ donation });
    });
  });
});

// DELETE donation
app.delete('/api/donations/:id', (req, res) => {
  const { id } = req.params;

  const deleteItemsSql = `DELETE FROM donation_items WHERE donationId = ?`;
  db.query(deleteItemsSql, [id], (err) => {
    if (err) {
      console.error('Delete items error:', err);
      return res.status(500).json({ error: 'Failed to delete donation items' });
    }

    const deleteDonationSql = `DELETE FROM donations WHERE id = ?`;
    db.query(deleteDonationSql, [id], (err2, result) => {
      if (err2) {
        console.error('Delete donation error:', err2);
        return res.status(500).json({ error: 'Failed to delete donation' });
      }
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Donation not found' });
      res.json({ success: true, message: 'Donation deleted successfully' });
    });
  });
});

// Contact
app.post('/api/contact', (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'All fields are required' });

  const sql = "INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)";
  db.query(sql, [name, email, message], (err) => {
    if (err) {
      console.error("Contact form DB error:", err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, message: 'Message sent successfully!' });
  });
});

// Feedback
app.post('/api/feedback', (req, res) => {
  const { name, email, message, rating } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: "All fields are required" });

  const sql = "INSERT INTO feedback (name, email, message, rating) VALUES (?, ?, ?, ?)";
  db.query(sql, [name, email, message, rating || 0], (err) => {
    if (err) {
      console.error("Feedback Insert Error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ success: true, message: "Thank you for your feedback!" });
  });
});

/* ----------------------------
   PROFILE Endpoints (GET + UPDATE including photo)
   ---------------------------- */

// Primary GET route (expects path param)
app.get('/api/users/:id/profile', (req, res) => {
  const { id } = req.params;
  const sql = "SELECT id, name, email, phone, photo_url FROM users WHERE id = ?";
  db.query(sql, [id], (err, results) => {
    if (err) {
      console.error('Profile GET DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (results.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(results[0]);
  });
});

// Backwards-compatible GET: support /api/users/profile?id=123 or header x-user-id
app.get('/api/users/profile', (req, res) => {
  const id = req.query.id || req.headers['x-user-id'] || null;
  if (!id) {
    return res.status(400).json({
      error: 'Missing user id',
      help: 'Call /api/users/:id/profile OR /api/users/profile?id=123 OR set header x-user-id:123',
      requested: req.originalUrl
    });
  }

  const sql = "SELECT id, name, email, phone, photo_url FROM users WHERE id = ?";
  db.query(sql, [id], (err, results) => {
    if (err) {
      console.error('Profile GET DB error (alt):', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (results.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(results[0]);
  });
});

// UPDATE profile (supports optional 'photo' file upload)
app.put('/api/users/:id/profile', upload.single('photo'), (req, res) => {
  const { id } = req.params;
  const { name, email, phone } = req.body;

  if (!name || !email) {
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Name and email are required' });
  }

  if (req.file) {
    const photoUrl = `/uploads/${path.basename(req.file.path)}`;
    const sql = "UPDATE users SET name = ?, email = ?, phone = ?, photo_url = ? WHERE id = ?";
    db.query(sql, [name, email, phone || null, photoUrl, id], (err, result) => {
      if (err) {
        console.error('Profile UPDATE DB error (with file):', err);
        fs.unlink(req.file.path, () => {});
        return res.status(500).json({ error: 'Database error' });
      }
      if (result.affectedRows === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ success: true, message: 'Profile updated', photo_url: photoUrl });
    });
  } else {
    const sql = "UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?";
    db.query(sql, [name, email, phone || null, id], (err, result) => {
      if (err) {
        console.error('Profile UPDATE DB error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true, message: 'Profile updated' });
    });
  }
});

/* ----------------------------
   Fixed Catch-all & Error Handler
   ---------------------------- */

// Log unmatched api requests and return JSON (use '/api' not '/api/*')
app.use('/api', (req, res) => {
  // If we reach here, no earlier route handled the request
  console.warn('Unmatched API request:', req.method, req.originalUrl);
  res.status(404).json({ error: 'API endpoint not found', requested: req.originalUrl });
});

// Global error handler (returns JSON). Multer errors handled here too.
app.use((err, req, res, next) => {
  console.error('Global error:', err && (err.stack || err));
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  // Multer may also produce a plain Error (fileFilter), so handle that:
  if (err && err.message && err.message.includes('Only JPG/PNG')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err && (err.message || 'Server error') });
});

/* ----------------------------
   Start server
   ---------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
