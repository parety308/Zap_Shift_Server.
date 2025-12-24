const express = require('express');
require('dotenv').config();
const app = express()
const port = process.env.PORT;

app.get('/', (req, res) => {
    res.send('Zap Shift Backend is Running')
})

app.listen(port, () => {
    console.log(`Zap Shift app listening on port ${port}`)
})
