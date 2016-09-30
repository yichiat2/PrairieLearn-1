var ERR = require('async-stacktrace');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var favicon = require('serve-favicon');
var async = require('async');
var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var https = require('https');

var logger = require('./logger');
var error = require('./error');
var config = require('./config');
var sqldb = require('./sqldb');
var models = require('./models');
var sprocs = require('./sprocs');
var cron = require('./cron');
var syncFromDisk = require('./sync/syncFromDisk');
var syncFromMongo = require('./sync/syncFromMongo');

logger.infoOverride('PrairieLearn server start');

configFilename = 'config.json';
if (process.argv.length > 2) {
    configFilename = process.argv[2];
}

config.loadConfig(configFilename);

if (config.logFilename) {
    logger.addFileLogging(config.logFilename);
    logger.info('activated file logging: ' + config.logFilename);
}

var app = express();
app.set('views', __dirname);
app.set('view engine', 'ejs');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for all requests
app.use(require('./middlewares/cors'));
app.use(require('./middlewares/authn'));
app.use(require('./middlewares/logRequest'));
app.use(require('./middlewares/parsePostData'));

// homepage doesn't need authorization
app.use('/pl', require('./pages/home'));

// all other pages need authorization
app.use('/pl/:course_instance_id', require('./middlewares/authzCourseInstance'));
app.use('/pl/:course_instance_id', require('./middlewares/navData'));
app.use('/pl/:course_instance_id', require('./middlewares/urlPrefix'));

// redirect plain class page to assessments page
app.use(function(req, res, next) {if (/\/pl\/[0-9]+\/?$/.test(req.url)) {req.url = req.url.replace(/\/?$/, '/assessments');} next();});

// polymorphic pages check role/type/etc and call next() if they aren't the right page
app.use('/pl/:course_instance_id/assessments', [
    require('./pages/adminAssessments/adminAssessments'),
    require('./pages/userAssessments/userAssessments'),
]);
app.use('/pl/:course_instance_id/assessment', [
    require('./pages/adminAssessment/adminAssessment'),
    require('./pages/userAssessmentHomework/userAssessmentHomework'),
    require('./pages/userAssessmentExam/userAssessmentExam'),
]);
app.use('/pl/:course_instance_id/assessment_instance', [
    require('./pages/adminAssessmentInstance/adminAssessmentInstance'),
    require('./pages/userAssessmentInstanceHomework/userAssessmentInstanceHomework'),
    require('./pages/userAssessmentInstanceExam/userAssessmentInstanceExam'),
]);
app.use('/pl/:course_instance_id/users', [
    require('./pages/adminUsers/adminUsers'),
]);
app.use('/pl/:course_instance_id/questions', [
    require('./pages/adminQuestions/adminQuestions'),
]);
app.use('/pl/:course_instance_id/question', [
    require('./pages/adminQuestion/adminQuestion'),
]);

// error handling
app.use(require('./middlewares/notFound'));
app.use(require('./pages/error/error'));

var startServer = function(callback) {
    if (config.serverType === 'https') {
        var options = {
            key: fs.readFileSync('/etc/pki/tls/private/localhost.key'),
            cert: fs.readFileSync('/etc/pki/tls/certs/localhost.crt'),
            ca: [fs.readFileSync('/etc/pki/tls/certs/server-chain.crt')]
        };
        https.createServer(options, app).listen(config.serverPort);
        logger.info('server listening to HTTPS on port ' + config.serverPort);
        callback(null);
    } else if (config.serverType === 'http') {
        app.listen(config.serverPort);
        logger.info('server listening to HTTP on port ' + config.serverPort);
        callback(null);
    } else {
        callback('unknown serverType: ' + config.serverType);
    }
};

async.series([
    function(callback) {
        var pgConfig = {
            user: config.postgresqlUser,
            database: config.postgresqlDatabase,
            host: config.postgresqlHost,
            max: 10,
            idleTimeoutMillis: 30000,
        };

        var idleErrorHandler = function(err) {
            logger.error(error.makeWithData('idle client error', {err: err}));
        };
        sqldb.init(pgConfig, idleErrorHandler, function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    function(callback) {
        models.init(function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    function(callback) {
        sprocs.init(function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    function(callback) {
        cron.init(function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    function(callback) {
        startServer.init(function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    // FIXME: we are short-circuiting this for development,
    // for prod these tasks should be back inline
    function(callback) {
        callback(null);
        async.eachSeries(config.courseDirs || [], function(courseDir, callback) {
            syncFromDisk.syncDiskToSql(courseDir, callback);
        }, function(err, data) {
            if (err) {
                logger.error('Error syncing SQL DB:', err, data, err.stack);
            } else {
                logger.infoOverride('Completed sync SQL DB');
            }
        });

        /*        
        async.series([
            syncDiskToSQL,
            syncMongoToSQL,
        ], function(err, data) {
            if (err) {
                logger.error('Error syncing SQL DB:', err, data);
            }
        });
        */
    },
], function(err, data) {
    if (err) {
        logger.error('Error initializing PrairieLearn server:', err, data);
        logger.error('Exiting...');
        process.exit(1);
    } else {
        logger.infoOverride('PrairieLearn server ready');
    }
});

//module.exports = app;
