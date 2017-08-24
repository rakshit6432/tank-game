/**
 *  Class for writing game logic functions and steps in a more readable way.
 * Purpose is to remove game logic from server.js, which I would like to basically just have framework code.
 */

var config = require('../../../config.json');
var Wall = require('./wall');
var Bullet = require('./bullet');
var Track = require('./track');
var Direction = require('./direction');
var util = require('./util');
var winston = require('winston');
winston.level = 'debug';

class GameLogicService {
    constructor(quadtreeManager) {
        this.quadtreeManager = quadtreeManager;
        this.quadtree = quadtreeManager.getQuadtree();
    }

    //this initializeGame() code can pretty much take as long as it wants, no players will be waiting for this code to finish
    initializeGame() {
        /**
         * Initialize border walls, put them in the quadtree
         * I'm still not sure I want to use the quadtree to store data for the borders.
         * I don't know how much it will help us, it might even not help. 
         */
        var leftBorderWall = new Wall(0, 0, config.wall.width, config.gameHeight);
        var topBorderWall = new Wall(config.wall.width, 0, config.gameWidth - 2 * config.wall.width, config.wall.width);
        var rightBorderWall = new Wall(config.gameWidth - config.wall.width, 0, config.wall.width, config.gameHeight);
        var bottomBorderWall = new Wall(config.wall.width, config.gameHeight - config.wall.width, config.gameWidth - 2 * config.wall.width, config.wall.width);

        this.quadtree.put(leftBorderWall.forQuadtree());
        this.quadtree.put(topBorderWall.forQuadtree());
        this.quadtree.put(rightBorderWall.forQuadtree());
        this.quadtree.put(bottomBorderWall.forQuadtree());

        for(var i = 0; i < config.wall.count; i++){
            //random x,y to start barrier
            var x = Math.floor((Math.random() * config.gameWidth));
            var y = Math.floor((Math.random() * config.gameHeight));


            var w;
            var h;

            /*
                Half the rows tend to be wider than long, the other half tend to be longer than wide.
                I did this because I want more rectangular shapes than square shapes.
             */
            if(i % 2 === 0){
                w = Math.max(config.wall.minDimension, Math.floor((Math.random() * (config.wall.maxDimension / 3))));
                h = Math.max(config.wall.minDimension,Math.floor((Math.random() * config.wall.maxDimension)));
            }else{
                w = Math.max(config.wall.minDimension, Math.floor((Math.random() * config.wall.maxDimension)));
                h = Math.max(config.wall.minDimension,Math.floor((Math.random() * (config.wall.maxDimension / 3))));
            }

            var wall = new Wall(x,y,Math.min(config.gameWidth - x,w),Math.min(config.gameHeight - y,h));
            this.quadtree.put(wall.forQuadtree());
        }
    }

    gameTick(clientData, socket, currentClientDatas) {
        var currentTime = new Date().getTime();

        if(clientData.lastHeartbeat < currentTime - config.maxLastHeartBeat){
            winston.log('debug',`Kicking player ${clientData.tank.screenName}`);
            this.kill(clientData, socket);
        }else{
            this.updateTank(clientData);
            this.increaseAmmoIfNecessary(clientData, currentTime);
            this.updatePositionsOfBullets(clientData, this.quadtreeManager, currentTime);
            this.fireBulletsIfNecessary(clientData, currentTime);
            this.handleCollisionsOnTank(clientData, socket, currentClientDatas);
            this.updateTracks(this.quadtreeManager, this.quadtree);
        }
    }

    updateTank(clientData) {
        let player = clientData.player;
        let tank = clientData.tank;

        if(typeof player.userInput.mouseAngle !== 'undefined') {
            // Set tank gun angle
            tank.gunAngle = player.userInput.mouseAngle;
        }

        var oldTank = tank.forQuadtree();
        var oldPosition = clientData.position;
        var newPosition = { x: clientData.position.x, y: clientData.position.y };

        let xChange = 0;
        let yChange = 0;

        if(player.userInput.keysPressed['KEY_RIGHT']) {
            xChange += config.tank.normalSpeed;
        }
        if(player.userInput.keysPressed['KEY_LEFT']) {
            xChange -= config.tank.normalSpeed;
        }
        if(player.userInput.keysPressed['KEY_DOWN']) {
            yChange += config.tank.normalSpeed;
        }
        if(player.userInput.keysPressed['KEY_UP']) {
            yChange -= config.tank.normalSpeed;
        }

        // Check that user is moving diagonally
        if(xChange !== 0 && yChange !== 0) {
            // Calculate equivalent x & y coord. changes for moving diagonally at same speed as horizontally/vertically
            // The change for x & y will be smaller for moving diagonally
            let diagSpeedFactor = Math.sqrt(Math.pow(config.tank.normalSpeed, 2) / 2);
            xChange = Math.sign(xChange) * diagSpeedFactor;
            yChange = Math.sign(yChange) * diagSpeedFactor;
        }

        // Check if player is pressing key to BOOST
        if(player.userInput.keysPressed['KEY_SPACE']) {
            xChange *= config.tank.boostFactor;
            yChange *= config.tank.boostFactor;
        }

        tank.xChange = xChange;
        tank.yChange = yChange;

        newPosition.x = oldPosition.x + xChange;
        newPosition.y = oldPosition.y + yChange;

        // Check if tank has moved since last update
        // (Necessary to check because otherwise tank's direction will keep going
        // back to North every time that it stops moving)
        if(!util.areCoordinatesEqual(oldPosition, newPosition)) {
            // Tank has moved so update its direction
            let angleInRadians = Math.atan2(newPosition.y - oldPosition.y, newPosition.x - oldPosition.x);

            // Convert radians to positive if negative: Math.atan2() has range of (-PI, PI)
            angleInRadians = Number((angleInRadians + 2 * Math.PI) % (2 * Math.PI)).toFixed(5);

            tank.hullAngle = angleInRadians;

            // Update tank's frame since tank is moving
            tank.spriteTankHull.update();

            this.addTracks(tank, newPosition, angleInRadians);
        }

        var objects = this.quadtreeManager.queryGameObjectsForType(['WALL', 'TANK'], {x: newPosition.x - config.tank.width / 2, y: newPosition.y - config.tank.height / 2, w: config.tank.width, h: config.tank.height});
        if(!objects['WALL'].length && (objects['TANK'].length === 1)) {
            clientData.position = newPosition;

            // Update Tank object on QuadTree
            this.quadtree.remove(oldTank, 'id');
            this.quadtree.put(tank.forQuadtree());
        }
    };

    /**
     * Adds tracks for the current tank to the QuadTree and associates the tracks with a certain tank path.
     *
     * @param tank
     * @param newPosition
     * @param angleInRadians
     */
    addTracks(tank, newPosition, angleInRadians) {
        // Check if delay been track creation has finished
        if(!tank.path.hasFinishedDelay()) {
            // Delay has not been reached so don't create more tracks
            return;
        }

        let trackOneDestX = 0;
        let trackOneDestY = 0;
        let trackTwoDestX = 0;
        let trackTwoDestY = 0;

        let scaledHalfSingleFrame = tank.spriteTankHull.singleFrameWidth / 2 * tank.spriteTankHull.scaleFactorWidth;

        // Correction is the value from the center of the tank (newPosition.x, newPosition.y) to where the the track
        // actually needs to be rendered (i.e. in line with the left/right tank wheel).
        //
        // Came up with the magic fractions below by first seeing what number of units needed to move for this specific
        // tank sprite width and height (config values were 85 px for width/height). In this case, correction value
        // turned out to be 22.5 for horizontal/vertical and 32 for vertical) and then divided these values
        // by scaledHalfSingleFrame:
        //     22.5 / 42.5 = 0.529411764705882
        //     32.0 / 42.5 = 0.752941176470588
        //
        // These magical fractions allow the tracks to be rendered at the correct location behind a tank's wheels for
        // any size tank (i.e. tank width/height can be changed without having to manually fix where the tracks are
        // rendered).
        let straightCorrection = 0.52941 * scaledHalfSingleFrame;
        let diagonalCorrection = 0.75294 * scaledHalfSingleFrame;

        switch(angleInRadians) {
            case Direction.E: // East
                trackOneDestX = newPosition.x + straightCorrection;
                trackOneDestY = newPosition.y - straightCorrection;
                trackTwoDestX = newPosition.x + straightCorrection;
                trackTwoDestY = newPosition.y + straightCorrection;
                break;
            case Direction.SE: // South East
                trackOneDestX = newPosition.x;
                trackOneDestY = newPosition.y + diagonalCorrection;
                trackTwoDestX = newPosition.x + diagonalCorrection;
                trackTwoDestY = newPosition.y;
                break;
            case Direction.S: // South
                trackOneDestX = newPosition.x - straightCorrection;
                trackOneDestY = newPosition.y + straightCorrection;
                trackTwoDestX = newPosition.x + straightCorrection;
                trackTwoDestY = newPosition.y + straightCorrection;
                break;
            case Direction.SW: // South West
                trackOneDestX = newPosition.x - diagonalCorrection;
                trackOneDestY = newPosition.y;
                trackTwoDestX = newPosition.x;
                trackTwoDestY = newPosition.y + diagonalCorrection;
                break;
            case Direction.W: // West
                trackOneDestX = newPosition.x - straightCorrection;
                trackOneDestY = newPosition.y - straightCorrection;
                trackTwoDestX = newPosition.x - straightCorrection;
                trackTwoDestY = newPosition.y + straightCorrection;
                break;
            case Direction.NW: // North West
                trackOneDestX = newPosition.x - diagonalCorrection;
                trackOneDestY = newPosition.y;
                trackTwoDestX = newPosition.x;
                trackTwoDestY = newPosition.y - diagonalCorrection;
                break;
            case Direction.N: // North
                trackOneDestX = newPosition.x - straightCorrection;
                trackOneDestY = newPosition.y - straightCorrection;
                trackTwoDestX = newPosition.x + straightCorrection;
                trackTwoDestY = newPosition.y - straightCorrection;
                break;
            case Direction.NE: // North East
                trackOneDestX = newPosition.x;
                trackOneDestY = newPosition.y - diagonalCorrection;
                trackTwoDestX = newPosition.x + diagonalCorrection;
                trackTwoDestY = newPosition.y;
                break;
        }

        let trackOne = new Track(trackOneDestX, trackOneDestY, angleInRadians, tank.path.id);
        let trackTwo = new Track(trackTwoDestX , trackTwoDestY, angleInRadians, tank.path.id);

        // Add new tank tracks since tank has changed location
        this.quadtree.put(trackOne.forQuadtree());
        this.quadtree.put(trackTwo.forQuadtree());
    };

    increaseAmmoIfNecessary(clientData, time) {
        /**
         * Increase ammo if necessary
         */
        if(clientData.tank.ammo < config.tank.ammoCapacity && ((time - clientData.tank.lastAmmoEarned > config.tank.timeToGainAmmo) || typeof clientData.tank.lastAmmoEarned === 'undefined')){
            clientData.tank.ammo = clientData.tank.ammo + 1;
            clientData.tank.lastAmmoEarned = time;
        }
    };

    updatePositionsOfBullets(clientData, quadtreeManager, time) {
        /**
        * Update positions of all the bullets
        */
        for(var bullet of clientData.tank.bullets) {
            let currentBulletLocation = bullet.forQuadtree();

            //if bullet is in wall, update the position to reflect a bounce off the wall
            var walls = quadtreeManager.queryGameObjectsForType(['WALL'], currentBulletLocation)['WALL'];
            if(walls.length && !bullet.isInWall){
                bullet.isInWall = true;
                var wall = walls[0];
                //I need to find out which side of the wall the bullet is hitting, this is a PITA
                if((bullet.oldX + config.bullet.width) < wall.x){
                    //old bullet x was less than wall x, bullet was coming from left side
                    bullet.velocityX = -bullet.velocityX;
                }else if(bullet.oldX > (wall.x + wall.w)){
                    //old bullet x was greater than wall x, bullet was coming from right side
                    bullet.velocityX = -bullet.velocityX;
                }else if((bullet.oldY + config.bullet.height) < wall.y){
                    //old bullet y was less than wall y, came from above
                    bullet.velocityY = -bullet.velocityY;
                }else if(bullet.oldY >  (wall.y + wall.h)){
                    //old bullet y is greater than wall y, came from below
                    bullet.velocityY = -bullet.velocityY;
                }
            }else{
                bullet.isInWall = false;
            }
            bullet.oldX = bullet.x;
            bullet.oldY = bullet.y;
            bullet.x = bullet.x + bullet.velocityX;
            bullet.y = bullet.y + bullet.velocityY;

            let forQuadtree = bullet.forQuadtree();

            this.quadtree.remove(currentBulletLocation, 'id');
            this.quadtree.put(forQuadtree);

            //if it is time for bullet to die, let it die
            if(time - bullet.timeCreated > config.bullet.timeToLive){
                let bulletIndex = util.findIndex(clientData.tank.bullets, bullet.id);
                if(bulletIndex > -1){
                    clientData.tank.bullets.splice(bulletIndex,1);
                    this.quadtree.remove(bullet.forQuadtree(), 'id');
                }
            }
        }
    };

    fireBulletsIfNecessary(clientData, time) {
        /**
        * Fire bullets if necessary
        */
        if(typeof clientData.player.userInput.mouseClicked !== 'undefined') {
            if(clientData.player.userInput.mouseClicked &&
                clientData.tank.ammo > 0 &&
                (typeof clientData.tank.lastFireTime === 'undefined' ||
                (time - clientData.tank.lastFireTime > config.tank.fireTimeWait))) {

                clientData.tank.lastFireTime = time;
                clientData.tank.ammo = clientData.tank.ammo - 1;

                var xComponent = Math.cos(clientData.tank.gunAngle);
                var yComponent = -Math.sin(clientData.tank.gunAngle);

                var bullet = new Bullet(clientData.id,
                    clientData.tank.x + (xComponent * config.tank.barrelLength),
                    clientData.tank.y + (yComponent * config.tank.barrelLength),
                    (xComponent * config.bullet.velocity) + clientData.tank.xChange,
                    (yComponent * config.bullet.velocity) + clientData.tank.yChange);

                this.quadtree.put(bullet.forQuadtree());
                clientData.tank.bullets.push(bullet);
            }
        }
    };

    handleCollisionsOnTank(clientData, socket, currentClientDatas) {
        /**
         * Check any collisions on tank
         */
        var objectsInTankArea = this.quadtree.get(clientData.tank.forQuadtree());
        for(var objectInTankArea of objectsInTankArea){
            if(objectInTankArea.type === 'BULLET'){
                var bullet = objectInTankArea.object;

                // Check if bullet belongs to tank who shot the bullet
                if(bullet.ownerId === clientData.tank.id) {
                    // Stop tanks from killing themselves
                    continue;
                }

                var playerIndex = util.findIndex(currentClientDatas, bullet.ownerId);

                //update that player's score
                currentClientDatas[playerIndex].tank.kills = currentClientDatas[playerIndex].tank.kills + 1;

                //remove bullet
                if(playerIndex > -1) {
                    var bulletIndex = util.findIndex(currentClientDatas[playerIndex].tank.bullets, bullet.id);
                    if(bulletIndex > -1){
                        currentClientDatas[playerIndex].tank.bullets.splice(bulletIndex,1);
                        this.quadtree.remove(bullet.forQuadtree(), 'id');
                    }
                }
                //destroy tank
                this.kill(clientData, socket);
            }
        }
    }

    updateTracks(quadtreeManager, quadtree) {
        var objects = quadtreeManager.queryGameObjectsForType(['TRACK']);
        objects['TRACK'].forEach(function(track) {
            // Check if track should disappear
            if(track.hasExpired()) {
                // Remove track by uniquely identifiable attribute
                quadtree.remove(track.forQuadtree(), 'id');
            }
            else {
                // Update track (remove existing and put track with updated tickCount)
                // tickCount was updated in call to hasExpired
                quadtree.remove(track.forQuadtree(), 'id');
                quadtree.put(track.forQuadtree());
            }
        });
    };

    kill(clientData, socket){
        socket.emit('death');
        socket.disconnect();
    }


    /*
     * This code is dangerous, will try to place user over and over again indefinitely,
     * need to eventually have a max amount of tries. We can't just stall the entire game because someone can't be placed.
     * I hope to make the game board dynamically grow.
     */
    static getSpawnLocation(quadtreeManager){
        outerLoop: while(true){
            //generate random x and y within the board
            var x = Math.floor((Math.random() * config.gameWidth));
            var y = Math.floor((Math.random() * config.gameHeight));

            //query quadtree for objects of certain type within a certain area of that location
            //TODO optimize by directly using the quadtree, which can stop a query once a certain object is found
            var objects = quadtreeManager.queryGameObjectsForType(['BULLET', 'WALL', 'TANK'], {x:(x - config.spawnAreaWidth / 2), y:(y - config.spawnAreaHeight / 2), w: config.spawnAreaWidth , h: config.spawnAreaHeight });

            //if any of the objects came back which can kill a tank, get different random coordinates
            for(var key of Object.keys(objects)){
                if (objects.hasOwnProperty(key) && objects[key].length > 0) {
                    continue outerLoop;
                }
            }

            return {
                x: x,
                y: y
            }

        }

    }

}

module.exports = GameLogicService;