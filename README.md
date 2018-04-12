# leela-zero-server
## Dev Environment Setup
### Requirements
- Node.js (https://nodejs.org/en/download/)
  - Latest LTS Version should includes `npm`
- MongoDB Community Server (https://www.mongodb.com/download-center#community)
  - MongoDB Compass is optional

### Before running `node server.js`
- Ensure MongoDB is running locally on port `27017`
- Ensure dummy `auth_key` file is created at project root
- Ensure `network/best-network.gz` exists (you could download it from http://zero.sjeng.org/best-network)
- Run `npm install` to get required packages

Your project folder should look like this
```
- Project Root/
  - network/
    - best-network.gz
  - node_modules/        (generated from `npm update`)
    - ...                (bunch of packages)
  - static/
  - views/
  - auth_key             (dummy file)
  - ...                  (and other project files)
  - server.js
  
  
```

# License

The code is released under the AGPLv3 or later.
