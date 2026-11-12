const mongoose = require('mongoose');

// In test mode we use a separate database so tests never touch real data.
const connectDB = async () => {
  const options = process.env.NODE_ENV === 'test' ? { dbName: 'docreader_test' } : {};
  try {
    await mongoose.connect(process.env.MONGODB_URI, options);
    console.log('MongoDB Connected Successfully!');
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    if (process.env.NODE_ENV === 'test') throw error;
    process.exit(1);
  }
};

module.exports = connectDB;
