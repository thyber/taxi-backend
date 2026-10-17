require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

const Driver = require('./models/Driver');
const Passenger = require('./models/Passenger');
const createMapsRoutes = require('./routes/maps');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../admin-web')));

// FASE 7F.8A: proxy de Google Maps. Se monta sobre el servidor existente sin
// alterar ninguna ruta ni lógica previa. La clave de Google permanece en el
// servidor (GOOGLE_MAPS_SERVER_KEY).
app.use('/api/maps', createMapsRoutes());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch(err => console.error('❌ Error conectando a MongoDB:', err));

const activeDrivers = new Map();
const activeRides = new Map();
const completedRides = [];

function getRideSnapshot() {
  return [
    ...Array.from(activeRides.values()),
    ...completedRides
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function emitSystemSnapshot(target = io) {
  target.emit('driver-list-update', Array.from(activeDrivers.values()));
  target.emit('ride-snapshot', getRideSnapshot());
}

const FARE_CONFIG = {
  perKm: 3,
  currency: 'BOB'
};

function calculateFare(distanceKm, durationMinutes) {
  return distanceKm * FARE_CONFIG.perKm;
}

function estimateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLng/2) * Math.sin(dLng/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

app.post('/api/auth/register/driver', async (req, res) => {
  try {
    const { name, email, phone, password, vehicle, licensePlate } = req.body;
    
    const existingDriver = await Driver.findOne({ 
      $or: [{ email }, { phone }] 
    });
    
    if (existingDriver) {
      return res.status(400).json({ 
        success: false, 
        message: 'El correo o teléfono ya está registrado' 
      });
    }
    
    const driver = new Driver({
      name,
      email,
      phone,
      password,
      vehicle,
      licensePlate
    });
    
    await driver.save();
    
    const token = jwt.sign(
      { id: driver._id, type: 'driver' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.status(201).json({
      success: true,
      message: 'Conductor registrado exitosamente',
      token,
      driver: {
        id: driver._id,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        vehicle: driver.vehicle,
        licensePlate: driver.licensePlate
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error del servidor',
      error: error.message 
    });
  }
});

app.post('/api/auth/register/passenger', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    
    const existingPassenger = await Passenger.findOne({ 
      $or: [{ email }, { phone }] 
    });
    
    if (existingPassenger) {
      return res.status(400).json({ 
        success: false, 
        message: 'El correo o teléfono ya está registrado' 
      });
    }
    
    const passenger = new Passenger({
      name,
      email,
      phone,
      password
    });
    
    await passenger.save();
    
    const token = jwt.sign(
      { id: passenger._id, type: 'passenger' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.status(201).json({
      success: true,
      message: 'Pasajero registrado exitosamente',
      token,
      passenger: {
        id: passenger._id,
        name: passenger.name,
        email: passenger.email,
        phone: passenger.phone
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error del servidor',
      error: error.message 
    });
  }
});

app.post('/api/auth/login/driver', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const driver = await Driver.findOne({ email });
    if (!driver) {
      return res.status(400).json({ 
        success: false, 
        message: 'Credenciales incorrectas' 
      });
    }
    
    const isMatch = await driver.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ 
        success: false, 
        message: 'Credenciales incorrectas' 
      });
    }
    
    const token = jwt.sign(
      { id: driver._id, type: 'driver' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
      success: true,
      message: 'Login exitoso',
      token,
      driver: {
        id: driver._id,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        vehicle: driver.vehicle,
        licensePlate: driver.licensePlate
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error del servidor',
      error: error.message 
    });
  }
});

app.post('/api/auth/login/passenger', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const passenger = await Passenger.findOne({ email });
    if (!passenger) {
      return res.status(400).json({ 
        success: false, 
        message: 'Credenciales incorrectas' 
      });
    }
    
    const isMatch = await passenger.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ 
        success: false, 
        message: 'Credenciales incorrectas' 
      });
    }
    
    const token = jwt.sign(
      { id: passenger._id, type: 'passenger' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
      success: true,
      message: 'Login exitoso',
      token,
      passenger: {
        id: passenger._id,
        name: passenger.name,
        email: passenger.email,
        phone: passenger.phone
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error del servidor',
      error: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor funcionando' });
});

app.get('/api/drivers', (req, res) => {
  const drivers = Array.from(activeDrivers.values());
  res.json({ drivers });
});

app.get('/api/rides', (req, res) => {
  const activeRidesList = Array.from(activeRides.values());
  res.json({ activeRides: activeRidesList, completedRides });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toDateString();
  const todayCompleted = completedRides.filter(ride => 
    new Date(ride.completedAt || ride.createdAt).toDateString() === today
  );
  const todayRevenue = todayCompleted.reduce((sum, ride) => sum + (parseFloat(ride.fare) || 0), 0);
  const todayActiveDrivers = activeDrivers.size;
  
  res.json({
    todayCompletedRides: todayCompleted.length,
    todayRevenue: todayRevenue.toFixed(2),
    todayActiveDrivers,
    totalCompletedRides: completedRides.length,
    activeRidesCount: activeRides.size
  });
});

app.post('/api/ride/estimate', (req, res) => {
  const { pickupLat, pickupLng, destLat, destLng } = req.body;
  
  const distance = estimateDistance(pickupLat, pickupLng, destLat, destLng);
  const estimatedDuration = distance * 5;
  const fare = calculateFare(distance, estimatedDuration);
  
  res.json({
    success: true,
    estimate: {
      distanceKm: distance.toFixed(2),
      durationMinutes: Math.round(estimatedDuration),
      fare: fare.toFixed(2)
    }
  });
});

app.post('/api/ride/request', (req, res) => {
  const { passengerId, pickup, destination, pickupLat, pickupLng, destLat, destLng, fare, distanceKm } = req.body;
  const rideId = Date.now().toString();
  
  const finalDistance = distanceKm || estimateDistance(pickupLat, pickupLng, destLat, destLng);
  const finalFare = fare || calculateFare(finalDistance, finalDistance * 5);
  
  const ride = {
    id: rideId,
    passengerId,
    pickup,
    destination,
    pickupLocation: { lat: pickupLat, lng: pickupLng },
    destLocation: { lat: destLat, lng: destLng },
    status: 'pending',
    driverId: null,
    fare: finalFare.toFixed ? finalFare.toFixed(2) : finalFare,
    distanceKm: finalDistance.toFixed ? finalDistance.toFixed(2) : finalDistance,
    createdAt: new Date()
  };
  
  activeRides.set(rideId, ride);
  
  io.emit('new-ride-request', ride);
  emitSystemSnapshot();
  
  res.json({ success: true, ride });
});

io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);
  emitSystemSnapshot(socket);

  socket.on('driver-online', (driverData) => {
    activeDrivers.set(socket.id, { 
      ...driverData, 
      socketId: socket.id, 
      status: 'available',
      todayRides: 0,
      todayEarnings: 0
    });
    emitSystemSnapshot();
    console.log('Conductor en línea:', driverData.name);
  });

  socket.on('driver-location-update', (location) => {
    const driver = activeDrivers.get(socket.id);
    if (driver) {
      driver.location = location;
      io.emit('driver-location-update', { driverId: socket.id, location });
      emitSystemSnapshot();
    }
  });

  socket.on('accept-ride', (data) => {
    const ride = activeRides.get(data.rideId);
    if (ride && ride.status === 'pending') {
      ride.driverId = socket.id;
      ride.status = 'accepted';
      ride.acceptedAt = new Date();
      
      const driver = activeDrivers.get(socket.id);
      if (driver) {
        driver.status = 'occupied';
      }
      
      io.to(ride.passengerId).emit('ride-accepted', ride);
      io.emit('ride-status-update', ride);
      emitSystemSnapshot();
    }
  });

  socket.on('start-ride', (data) => {
    const ride = activeRides.get(data.rideId);
    if (ride && ride.status === 'accepted') {
      ride.status = 'in_progress';
      ride.startedAt = new Date();
      io.to(ride.passengerId).emit('ride-started', ride);
      io.emit('ride-status-update', ride);
      emitSystemSnapshot();
    }
  });

  socket.on('complete-ride', (data) => {
    const ride = activeRides.get(data.rideId);
    if (ride && ride.status === 'in_progress') {
      ride.status = 'completed';
      ride.completedAt = new Date();
      
      const driver = activeDrivers.get(ride.driverId);
      if (driver) {
        driver.status = 'available';
        driver.todayRides = (driver.todayRides || 0) + 1;
        driver.todayEarnings = (driver.todayEarnings || 0) + parseFloat(ride.fare);
      }
      
      completedRides.push(ride);
      activeRides.delete(data.rideId);
      
      io.to(ride.passengerId).emit('ride-completed', ride);
      io.emit('ride-status-update', ride);
      emitSystemSnapshot();
    }
  });

  socket.on('cancel-ride', (data) => {
    const ride = activeRides.get(data.rideId);
    if (ride) {
      ride.status = 'cancelled';
      ride.cancelledAt = new Date();
      
      if (ride.driverId) {
        const driver = activeDrivers.get(ride.driverId);
        if (driver) {
          driver.status = 'available';
        }
      }
      
      activeRides.delete(data.rideId);
      
      if (ride.passengerId) {
        io.to(ride.passengerId).emit('ride-cancelled', ride);
      }
      io.emit('ride-status-update', ride);
      emitSystemSnapshot();
    }
  });

  socket.on('disconnect', () => {
    activeDrivers.delete(socket.id);
    emitSystemSnapshot();
    console.log('Cliente desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en http://0.0.0.0:${PORT}`);
  console.log(`Dispositivos en la red pueden conectarse a tu IP local en el puerto ${PORT}`);
});
