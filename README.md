[![Build status](https://ci.appveyor.com/api/projects/status/00n43r3349yrqpsk/branch/next?svg=true)](https://ci.appveyor.com/project/gcp/leela-zero-server/branch/next)



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
- Ensure `network/best-network.gz` & `network/<best-network-hash>.gz` both exist (you could download it from http://zero.sjeng.org/best-network)
- Build mongo index, run `mongodb.indexes` in mongo console
- Run `npm install` to get required packages

Your project folder should look like this
```
- Project Root/
  - network/
    - best-network.gz
    - <best-network-hash>.gz   (e.g. 39d465076ed1bdeaf4f85b35c2b569f604daa60076cbee9bbaab359f92a7c1c4.gz)
  - node_modules/              (generated from `npm update`)
    - ...                      (bunch of packages)
  - static/
  - views/
  - auth_key                   (dummy file)
  - task_secret                (dummy file)
  - ...                        (and other project files)
  - server.js
  
  
```

# License

The code is released under the AGPLv3 or later. See the [LICENSE](LICENSE) file for details.

# How to run the server

First of all, install both `nodejs` and `mongodb`. The version of `nodejs` available in the Ubuntu 16.04 repositories does not work, it is probably too old. Then, follow the following steps from the root directory of the repostory:
- run `npm install`
- make a `network` directory and copy the best network file, whose name should be `best-network.gz`
- make an `auth_key` file, containing the password which will be requested by the server for privileged operations
- make a `task_secret` file, contaning the secret which will be used to sign option hashes for matches
- run `mongodb < mongodb.indexes`
- start the server with `npm start`
- run `curl -F 'weights=@network/best-network.gz' -F training_count=0 -F 'key=@auth_key' http://localhost:8080/submit-network`

# Collections in the MongoDB database

## networks

- `_id`: internal identifier
- `hash`: hash value (it is 62b5417b64c46976795d10a6741801f15f857e5029681a42d02c9852097df4b9 for ELF networks)
- `ip`: IP address who submitted the network
- `training_count`: number of games in DB when training has been computed
- `training_steps`: number of steps of training
- `game_count`: self-plays with this network
- `filters`: number of filters
- `blocks`: number of blocks
- `description`: description of the network

## games

- `_id`: internal identifier
- `sgfhash`: hash value of the sgf
- `clientversion`: version of leelaz who played this game
- `data`: training data
- `ip`: IP address who submitted the game
- `movescount`: number of moves in the SGF
- `networkhash`: hash of the network used for this game
- `options_hash`: small hash of the options used to play this game
- `randomseed`: seed used to play this game
- `sgf`: SGF of the games
- `winnercolor`: color of the winner

## matches

- `_id`: internal identifier
- `network1`: hash of the first network
- `network2`: hash of the second network (if null, it will be changed to the current best network when it is scheduled the first time)
- `network1_losses`: number of times the first network has lost a game
- `network1_wins`: number of times the first network has won a game
- `game_count`: number of playes games
- `number_to_play`: number of games to play
- `options`: a dictionary with options for leelaz ( `resignation_percent`, `randomcnt`, `noise`, `playouts` , `visits` )
- `options_hash`: hash of the `options` dictionary

## match_games

- `_id`: internal identifier
- `sgfhash`: hash value of the sgf
- `clientversion`: version of leelaz who played this game
- `data`: training data
- `ip`: IP address who submitted the game
- `loserhash`: hash of the loser network
- `movescount`: number of moves in the SGF
- `options_hash`: hash of the options used for the match
- `score`: result of the game
- `randomseed`: seed used to play this game
- `sgf`: SGF of the games
- `winnercolor`: color of the winner
- `winnerhash`: hash of the winner network

# API and inner working

This is a very brief documentation of the web API of the server.
- `/best-network-hash`: returns two rows: the first one is the hash of the network in `network/best-network.gz`, the second one contains the number `11` (why?).
- `/best-network`: returns the best network with filename `best-network.gz`. The file is actually retrieved by the network directory, using as a name the hash of the best network with an added `.gz` extension. This was used by `autogtp` in the past, but now `autogtp` directly downloads the network from the `network` directory (which, in production, is served by `nginx`).
- `/request-match`: submit the request of a match between networks. The request is added to the `matches` collection of the MongoDB database. When `/get-task` is called, self-play tasks and match tasks are interleaved. It is a privileged API. Parameters `playouts` and `visits` cannot be used togther. If they are both omitted, a default of 3200 visits is used.
  - `network1`: hash of the first network
  - `network2`: (optional) hash of the second network. If it is not provided, the current best network is used.
  - `playouts`: number of playouts to use for the games.
  - `visits`: numbr of visits to use for the games.
  - `resignation_percent`: (optional, default 5) win probability resignation threshold
  - `noise`: (optional, default false)
  - `randomcnt`: (optional, default 0)
  - `number_to_play`: (optional, default 400) numbers of games to play
  - `is_test`: (optional) if provided with value "1" or "true", this is a test match (i.e., it cannot cause promotions of the second network)
  - `key`: password for the privileged API
- `/submit-match`: submit a play corresponding to a match (i..e, a play between different networks). It may cause the current best-network to change. The play is added to the `match_games` collection. It is used by `autogtp` when a match-play is terminated.
  - `sgf`: a file with the gzipped SGF of the match
  - `clientversion`: version of the client AutoGTP
  - `winnerhash`: hash of the winning network
  - `loserhash`: hash of the losing network
  - `winnercolor`: color of the winner network
  - `movescount`: number of moves in the match
  - `score`: final score
  - `options_hash`: hash of the options used for the match
  - `random_seed`: seed used to play the match
- `/submit-network`: submit a new network. It causes a new entry with metadatas to be inserted into the `networks` collection , while the network itself is copied into the `network` directory. It is a privileged API. Parameters:
  - `weights`: gzipped file with the new network
  - `training_counts`: (optional) number of games in the DB when the training data has been exported. Default value is the number of games in the db.
  - `training_steps`: (optional) number of training steps of the network.
  - `description`: description of the network which is saved in the database.
  - `key`: password for the privileged API
- `/submit`: submit the result of a self-play. The game is added to the `games` collection, and the counter of `self-plays` for the related network is increased.  It is used by `autogtp` when a self-play is terminated.
  - `sgf`: a file with the gzipped SGF of the self-play
  - `trainingdata`: the training data to be recorded for generating chunks
  - `clientversion`: version of the client AutoGTP
  - `networkhash`: hash of the  network
  - `winnercolor`: color of the winner network
  - `movescount`: number of moves in the match
  - `options_hash`: hash of the options used for the match
  - `random_seed`: seed used to play the match
  - `verification`: the verification code previously sent by the server in the `get-task` reply
- `/network-profiles`: displays a page with detailed informations on non-ELF networks.
- `/network-profiles/<hash>`: displays a page with detailed informations on the non-ELF network with given hash.
- `/rss`: returns an RSS feed of best networks
- `/get-task/<autogtp-version>[/<leelaz-version>]`: requests a task for the given client versions (currently ignored). The result is a json encoding the type of match (self-play vs match) and other parameters for `autogtp` and `leelaz`. Used by `autogtp` when requesting a task.
- `/view/<hash>`: displays the SGF of the specified self-play.
- `/match-games/<matchid>`: displays the list of plays for the given match.
- `/viewmatch/<hash>`: displays the SGF of the specifietd match-play.
- `/viewmatch/<hash>.sgf`: returns the SGF of the specifietd match-play.
- `/data/elograph.json`: displays the ELO graph
- `/`: displays various statistics and general informations.

# Examples

## Submit a network

```
curl -F 'weights=@<network-file>' -F 'training_count=0' -F 'training_steps=80000' -F 'key=<password>' -F 'description=<description>' <server-url>/submit-network
```

## Request a match

```
curl -F 'network1=<network-hash>' -F 'key=<password>'  <server-url>/request-match
```

# Optional nginx configuration 

## Serve network files via nginx instead of node.js for higher performance

```
   location /networks {
        fancyindex on;
        fancyindex_default_sort date_desc;
        alias /home/jroy/code/leela-zero-server/network;
    }
```

