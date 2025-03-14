'use strict';

const globalStore = require('../lib/store');
const tuya = require('../lib/tuya');
const utils = require('../lib/utils');
const herdsman = require('zigbee-herdsman');
const legacy = require('../lib/legacy');
const light = require('../lib/light');
const constants = require('../lib/constants');
const libColor = require('../lib/color');
const exposes = require('../lib/exposes');

const manufacturerOptions = {
    xiaomi: {manufacturerCode: herdsman.Zcl.ManufacturerCode.LUMI_UNITED_TECH, disableDefaultResponse: true},
    osram: {manufacturerCode: herdsman.Zcl.ManufacturerCode.OSRAM},
    eurotronic: {manufacturerCode: herdsman.Zcl.ManufacturerCode.JENNIC},
    danfoss: {manufacturerCode: herdsman.Zcl.ManufacturerCode.DANFOSS},
    develco: {manufacturerCode: herdsman.Zcl.ManufacturerCode.DEVELCO},
    hue: {manufacturerCode: herdsman.Zcl.ManufacturerCode.PHILIPS},
    ikea: {manufacturerCode: herdsman.Zcl.ManufacturerCode.IKEA_OF_SWEDEN},
    sinope: {manufacturerCode: herdsman.Zcl.ManufacturerCode.SINOPE_TECH},
    /*
     * Ubisys doesn't accept a manufacturerCode on some commands
     * This bug has been reported, but it has not been fixed:
     * https://github.com/Koenkk/zigbee-herdsman/issues/52
     */
    ubisys: {manufacturerCode: herdsman.Zcl.ManufacturerCode.UBISYS},
    ubisysNull: {manufacturerCode: null},
    tint: {manufacturerCode: herdsman.Zcl.ManufacturerCode.MUELLER_LICHT_INT},
    legrand: {manufacturerCode: herdsman.Zcl.ManufacturerCode.VANTAGE, disableDefaultResponse: true},
    viessmann: {manufacturerCode: herdsman.Zcl.ManufacturerCode.VIESSMAN_ELEKTRO},
};

const converters = {
    // #region Generic converters
    read: {
        key: ['read'],
        convertSet: async (entity, key, value, meta) => {
            const result = await entity.read(value.cluster, value.attributes, (value.hasOwnProperty('options') ? value.options : {}));
            meta.logger.info(`Read result of '${value.cluster}': ${JSON.stringify(result)}`);
            if (value.hasOwnProperty('state_property')) {
                return {state: {[value.state_property]: result}};
            }
        },
    },
    write: {
        key: ['write'],
        convertSet: async (entity, key, value, meta) => {
            const options = utils.getOptions(meta.mapped, entity);
            if (value.hasOwnProperty('options')) {
                Object.assign(options, value.options);
            }
            await entity.write(value.cluster, value.payload, options);
            meta.logger.info(`Wrote '${JSON.stringify(value.payload)}' to '${value.cluster}'`);
        },
    },
    command: {
        key: ['command'],
        convertSet: async (entity, key, value, meta) => {
            const options = utils.getOptions(meta.mapped, entity);
            await entity.command(value.cluster, value.command, (value.hasOwnProperty('payload') ? value.payload : {}), options);
            meta.logger.info(`Invoked '${value.cluster}.${value.command}' with payload '${JSON.stringify(value.payload)}'`);
        },
    },
    factory_reset: {
        key: ['reset'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command('genBasic', 'resetFactDefault', {}, utils.getOptions(meta.mapped, entity));
        },
    },
    arm_mode: {
        key: ['arm_mode'],
        convertSet: async (entity, key, value, meta) => {
            const isNotification = value.hasOwnProperty('transaction');
            const modeSrc = isNotification ? constants.armNotification : constants.armMode;
            const mode = utils.getKey(modeSrc, value.mode, undefined, Number);
            if (mode === undefined) {
                throw new Error(`Unsupported mode: '${value.mode}', should be one of: ${Object.values(modeSrc)}`);
            }

            if (isNotification) {
                entity.commandResponse('ssIasAce', 'armRsp', {armnotification: mode}, {}, value.transaction);

                // Do not update PanelStatus after confirming transaction.
                // Instead the server should send an arm_mode command with the necessary state.
                // e.g. exit_delay as a result of arm_all_zones
                return;
            }

            let panelStatus = mode;
            if (meta.mapped.model === '3400-D') {
                panelStatus = mode !== 0 && mode !== 4 ? 0x80 : 0x00;
            }

            globalStore.putValue(entity, 'panelStatus', panelStatus);
            const payload = {panelstatus: panelStatus, secondsremain: 0, audiblenotif: 0, alarmstatus: 0};
            entity.commandResponse('ssIasAce', 'panelStatusChanged', payload);
        },
    },
    power_on_behavior: {
        key: ['power_on_behavior'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'off': 0, 'on': 1, 'toggle': 2, 'previous': 255};
            utils.validateValue(value, Object.keys(lookup));
            await entity.write('genOnOff', {startUpOnOff: lookup[value]}, utils.getOptions(meta.mapped, entity));
            return {state: {power_on_behavior: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['startUpOnOff']);
        },
    },
    light_color_mode: {
        key: ['color_mode'],
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', ['colorMode']);
        },
    },
    light_color_options: {
        key: ['color_options'],
        convertSet: async (entity, key, value, meta) => {
            const options = (value.hasOwnProperty('execute_if_off') && value.execute_if_off) ? 1 : 0;
            await entity.write('lightingColorCtrl', {options}, utils.getOptions(meta.mapped, entity));
            return {state: {'color_options': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', ['options']);
        },
    },
    lock: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command(
                'closuresDoorLock',
                `${value.toLowerCase()}Door`,
                {'pincodevalue': ''},
                utils.getOptions(meta.mapped, entity),
            );

            return {readAfterWriteTime: 200};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', ['lockState']);
        },
    },
    lock_auto_relock_time: {
        key: ['auto_relock_time'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('closuresDoorLock', {autoRelockTime: value}, utils.getOptions(meta.mapped, entity));
            return {state: {auto_relock_time: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', ['autoRelockTime']);
        },
    },
    lock_sound_volume: {
        key: ['sound_volume'],
        convertSet: async (entity, key, value, meta) => {
            utils.validateValue(value, constants.lockSoundVolume);
            await entity.write('closuresDoorLock',
                {soundVolume: constants.lockSoundVolume.indexOf(value)}, utils.getOptions(meta.mapped, entity));
            return {state: {sound_volume: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', ['soundVolume']);
        },
    },
    pincode_lock: {
        key: ['pin_code'],
        convertSet: async (entity, key, value, meta) => {
            const user = value.user;
            const userType = value.user_type || 'unrestricted';
            const userEnabled = value.hasOwnProperty('user_enabled') ? value.user_enabled : true;
            const pinCode = value.pin_code;
            if (isNaN(user)) throw new Error('user must be numbers');
            if (!utils.isInRange(0, meta.mapped.meta.pinCodeCount - 1, user)) throw new Error('user must be in range for device');

            if (pinCode == null) {
                await entity.command('closuresDoorLock', 'clearPinCode', {'userid': user}, utils.getOptions(meta.mapped));
            } else {
                if (isNaN(pinCode)) throw new Error('pinCode must be a number');
                const typeLookup = {'unrestricted': 0, 'year_day_schedule': 1, 'week_day_schedule': 2, 'master': 3, 'non_access': 4};
                utils.validateValue(userType, Object.keys(typeLookup));
                const payload = {
                    'userid': user,
                    'userstatus': userEnabled ? 1 : 3,
                    'usertype': typeLookup[userType],
                    'pincodevalue': pinCode.toString(),
                };
                await entity.command('closuresDoorLock', 'setPinCode', payload, utils.getOptions(meta.mapped));
            }
        },
        convertGet: async (entity, key, meta) => {
            const user = meta && meta.message && meta.message.pin_code ? meta.message.pin_code.user : undefined;
            if (user === undefined) {
                const max = meta.mapped.meta.pinCodeCount;
                // Get all
                const options = utils.getOptions(meta);
                for (let i = 0; i < max; i++) {
                    await entity.command('closuresDoorLock', 'getPinCode', {userid: i}, options);
                }
            } else {
                if (isNaN(user)) {
                    throw new Error('user must be numbers');
                }
                if (!utils.isInRange(0, meta.mapped.meta.pinCodeCount - 1, user)) {
                    throw new Error('userId must be in range for device');
                }

                await entity.command('closuresDoorLock', 'getPinCode', {userid: user}, utils.getOptions(meta));
            }
        },
    },
    lock_userstatus: {
        key: ['user_status'],
        convertSet: async (entity, key, value, meta) => {
            const user = value.user;
            if (isNaN(user)) {
                throw new Error('user must be numbers');
            }
            if (!utils.isInRange(0, meta.mapped.meta.pinCodeCount - 1, user)) {
                throw new Error('user must be in range for device');
            }

            const status = utils.getKey(constants.lockUserStatus, value.status, undefined, Number);

            if (status === undefined) {
                throw new Error(`Unsupported status: '${value.status}', should be one of: ${Object.values(constants.lockUserStatus)}`);
            }

            await entity.command(
                'closuresDoorLock',
                'setUserStatus',
                {
                    'userid': user,
                    'userstatus': status,
                },
                utils.getOptions(meta.mapped),
            );
        },
        convertGet: async (entity, key, meta) => {
            const user = meta && meta.message && meta.message.user_status ? meta.message.user_status.user : undefined;

            if (user === undefined) {
                const max = meta.mapped.meta.pinCodeCount;
                // Get all
                const options = utils.getOptions(meta);
                for (let i = 0; i < max; i++) {
                    await entity.command('closuresDoorLock', 'getUserStatus', {userid: i}, options);
                }
            } else {
                if (isNaN(user)) {
                    throw new Error('user must be numbers');
                }
                if (!utils.isInRange(0, meta.mapped.meta.pinCodeCount - 1, user)) {
                    throw new Error('userId must be in range for device');
                }

                await entity.command('closuresDoorLock', 'getUserStatus', {userid: user}, utils.getOptions(meta));
            }
        },
    },
    on_off: {
        key: ['state', 'on_time', 'off_wait_time'],
        convertSet: async (entity, key, value, meta) => {
            const state = meta.message.hasOwnProperty('state') ? meta.message.state.toLowerCase() : null;
            utils.validateValue(state, ['toggle', 'off', 'on']);

            if (state === 'on' && (meta.message.hasOwnProperty('on_time') || meta.message.hasOwnProperty('off_wait_time'))) {
                const onTime = meta.message.hasOwnProperty('on_time') ? meta.message.on_time : 0;
                const offWaitTime = meta.message.hasOwnProperty('off_wait_time') ? meta.message.off_wait_time : 0;

                if (typeof onTime !== 'number') {
                    throw Error('The on_time value must be a number!');
                }
                if (typeof offWaitTime !== 'number') {
                    throw Error('The off_wait_time value must be a number!');
                }

                const payload = {ctrlbits: 0, ontime: Math.round(onTime * 10), offwaittime: Math.round(offWaitTime * 10)};
                await entity.command('genOnOff', 'onWithTimedOff', payload, utils.getOptions(meta.mapped, entity));
            } else {
                await entity.command('genOnOff', state, {}, utils.getOptions(meta.mapped, entity));
                if (state === 'toggle') {
                    const currentState = meta.state[`state${meta.endpoint_name ? `_${meta.endpoint_name}` : ''}`];
                    return currentState ? {state: {state: currentState === 'OFF' ? 'ON' : 'OFF'}} : {};
                } else {
                    return {state: {state: state.toUpperCase()}};
                }
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['onOff']);
        },
    },
    cover_via_brightness: {
        key: ['position', 'state'],
        options: [exposes.options.invert_cover()],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'number') {
                value = value.toLowerCase();
                const lookup = {'open': 100, 'close': 0};
                utils.validateValue(value, Object.keys(lookup));
                value = lookup[value];
            }

            const invert = utils.getMetaValue(entity, meta.mapped, 'coverInverted', 'allEqual', false) ?
                !meta.options.invert_cover : meta.options.invert_cover;
            const position = invert ? 100 - value : value;
            await entity.command(
                'genLevelCtrl',
                'moveToLevelWithOnOff',
                {level: utils.mapNumberRange(Number(position), 0, 100, 0, 255).toString(), transtime: 0},
                utils.getOptions(meta.mapped, entity),
            );

            return {state: {position: value}, readAfterWriteTime: 0};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genLevelCtrl', ['currentLevel']);
        },
    },
    warning: {
        key: ['warning'],
        convertSet: async (entity, key, value, meta) => {
            const mode = {'stop': 0, 'burglar': 1, 'fire': 2, 'emergency': 3, 'police_panic': 4, 'fire_panic': 5, 'emergency_panic': 6};
            const level = {'low': 0, 'medium': 1, 'high': 2, 'very_high': 3};
            const strobeLevel = {'low': 0, 'medium': 1, 'high': 2, 'very_high': 3};

            const values = {
                mode: value.mode || 'emergency',
                level: value.level || 'medium',
                strobe: value.hasOwnProperty('strobe') ? value.strobe : true,
                duration: value.hasOwnProperty('duration') ? value.duration : 10,
                strobeDutyCycle: value.hasOwnProperty('strobe_duty_cycle') ? value.strobe_duty_cycle * 10 : 0,
                strobeLevel: value.hasOwnProperty('strobe_level') ? strobeLevel[value.strobe_level] : 1,
            };

            let info;
            // https://github.com/Koenkk/zigbee2mqtt/issues/8310 some devices require the info to be reversed.
            if (['SIRZB-110', 'SRAC-23B-ZBSR', 'AV2010/29A', 'AV2010/24A'].includes(meta.mapped.model)) {
                info = (mode[values.mode]) + ((values.strobe ? 1 : 0) << 4) + (level[values.level] << 6);
            } else {
                info = (mode[values.mode] << 4) + ((values.strobe ? 1 : 0) << 2) + (level[values.level]);
            }

            await entity.command(
                'ssIasWd',
                'startWarning',
                {startwarninginfo: info, warningduration: values.duration,
                    strobedutycycle: values.strobeDutyCycle, strobelevel: values.strobeLevel},
                utils.getOptions(meta.mapped, entity),
            );
        },
    },
    ias_max_duration: {
        key: ['max_duration'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('ssIasWd', {'maxDuration': value});
            return {state: {max_duration: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('ssIasWd', ['maxDuration']);
        },
    },
    warning_simple: {
        key: ['alarm'],
        convertSet: async (entity, key, value, meta) => {
            const alarmState = (value === 'OFF' ? 0 : 1);
            const info = (3 << 6) + ((alarmState) << 2);
            await entity.command(
                'ssIasWd',
                'startWarning',
                {startwarninginfo: info, warningduration: 300, strobedutycycle: 0, strobelevel: 0},
                utils.getOptions(meta.mapped, entity),
            );
        },
    },
    squawk: {
        key: ['squawk'],
        convertSet: async (entity, key, value, meta) => {
            const state = {'system_is_armed': 0, 'system_is_disarmed': 1};
            const level = {'low': 0, 'medium': 1, 'high': 2, 'very_high': 3};
            const values = {
                state: value.state,
                level: value.level || 'very_high',
                strobe: value.hasOwnProperty('strobe') ? value.strobe : false,
            };
            const info = (state[values.state]) + ((values.strobe ? 1 : 0) << 4) + (level[values.level] << 6);
            await entity.command('ssIasWd', 'squawk', {squawkinfo: info}, utils.getOptions(meta.mapped, entity));
        },
    },
    cover_state: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'open': 'upOpen', 'close': 'downClose', 'stop': 'stop', 'on': 'upOpen', 'off': 'downClose'};
            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));
            await entity.command('closuresWindowCovering', lookup[value], {}, utils.getOptions(meta.mapped, entity));
        },
    },
    cover_position_tilt: {
        key: ['position', 'tilt'],
        options: [exposes.options.invert_cover()],
        convertSet: async (entity, key, value, meta) => {
            const isPosition = (key === 'position');
            const invert = !(utils.getMetaValue(entity, meta.mapped, 'coverInverted', 'allEqual', false) ?
                !meta.options.invert_cover : meta.options.invert_cover);
            const position = invert ? 100 - value : value;

            // Zigbee officially expects 'open' to be 0 and 'closed' to be 100 whereas
            // HomeAssistant etc. work the other way round.
            // For zigbee-herdsman-converters: open = 100, close = 0
            await entity.command(
                'closuresWindowCovering',
                isPosition ? 'goToLiftPercentage' : 'goToTiltPercentage',
                isPosition ? {percentageliftvalue: position} : {percentagetiltvalue: position},
                utils.getOptions(meta.mapped, entity),
            );

            return {state: {[isPosition ? 'position' : 'tilt']: value}};
        },
        convertGet: async (entity, key, meta) => {
            const isPosition = (key === 'position');
            await entity.read('closuresWindowCovering', [isPosition ? 'currentPositionLiftPercentage' : 'currentPositionTiltPercentage']);
        },
    },
    occupancy_timeout: {
        // Sets delay after motion detector changes from occupied to unoccupied
        key: ['occupancy_timeout'],
        convertSet: async (entity, key, value, meta) => {
            value *= 1;
            await entity.write('msOccupancySensing', {pirOToUDelay: value}, utils.getOptions(meta.mapped, entity));
            return {state: {occupancy_timeout: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('msOccupancySensing', ['pirOToUDelay']);
        },
    },
    level_config: {
        key: ['level_config'],
        convertSet: async (entity, key, value, meta) => {
            const state = {};

            // parse payload to grab the keys
            if (typeof value === 'string') {
                try {
                    value = JSON.parse(value);
                } catch (e) {
                    throw new Error('Payload is not valid JSON');
                }
            }

            // onOffTransitionTime - range 0x0000 to 0xffff - optional
            if (value.hasOwnProperty('on_off_transition_time')) {
                let onOffTransitionTimeValue = Number(value.on_off_transition_time);
                if (onOffTransitionTimeValue > 65535) onOffTransitionTimeValue = 65535;
                if (onOffTransitionTimeValue < 0) onOffTransitionTimeValue = 0;

                await entity.write('genLevelCtrl', {onOffTransitionTime: onOffTransitionTimeValue}, utils.getOptions(meta.mapped, entity));
                Object.assign(state, {on_off_transition_time: onOffTransitionTimeValue});
            }

            // onTransitionTime - range 0x0000 to 0xffff - optional
            //                    0xffff = use onOffTransitionTime
            if (value.hasOwnProperty('on_transition_time')) {
                let onTransitionTimeValue = value.on_transition_time;
                if (typeof onTransitionTimeValue === 'string' && onTransitionTimeValue.toLowerCase() == 'disabled') {
                    onTransitionTimeValue = 65535;
                } else {
                    onTransitionTimeValue = Number(onTransitionTimeValue);
                }
                if (onTransitionTimeValue > 65535) onTransitionTimeValue = 65534;
                if (onTransitionTimeValue < 0) onTransitionTimeValue = 0;

                await entity.write('genLevelCtrl', {onTransitionTime: onTransitionTimeValue}, utils.getOptions(meta.mapped, entity));

                // reverse translate number -> preset
                if (onTransitionTimeValue == 65535) {
                    onTransitionTimeValue = 'disabled';
                }
                Object.assign(state, {on_transition_time: onTransitionTimeValue});
            }

            // offTransitionTime - range 0x0000 to 0xffff - optional
            //                    0xffff = use onOffTransitionTime
            if (value.hasOwnProperty('off_transition_time')) {
                let offTransitionTimeValue = value.off_transition_time;
                if (typeof offTransitionTimeValue === 'string' && offTransitionTimeValue.toLowerCase() == 'disabled') {
                    offTransitionTimeValue = 65535;
                } else {
                    offTransitionTimeValue = Number(offTransitionTimeValue);
                }
                if (offTransitionTimeValue > 65535) offTransitionTimeValue = 65534;
                if (offTransitionTimeValue < 0) offTransitionTimeValue = 0;

                await entity.write('genLevelCtrl', {offTransitionTime: offTransitionTimeValue}, utils.getOptions(meta.mapped, entity));

                // reverse translate number -> preset
                if (offTransitionTimeValue == 65535) {
                    offTransitionTimeValue = 'disabled';
                }
                Object.assign(state, {off_transition_time: offTransitionTimeValue});
            }

            // startUpCurrentLevel - range 0x00 to 0xff - optional
            //                       0x00 = return to minimum supported level
            //                       0xff = return to previous previous
            if (value.hasOwnProperty('current_level_startup')) {
                let startUpCurrentLevelValue = value.current_level_startup;
                if (typeof startUpCurrentLevelValue === 'string' && startUpCurrentLevelValue.toLowerCase() == 'previous') {
                    startUpCurrentLevelValue = 255;
                } else if (typeof startUpCurrentLevelValue === 'string' && startUpCurrentLevelValue.toLowerCase() == 'minimum') {
                    startUpCurrentLevelValue = 0;
                } else {
                    startUpCurrentLevelValue = Number(startUpCurrentLevelValue);
                }
                if (startUpCurrentLevelValue > 255) startUpCurrentLevelValue = 254;
                if (startUpCurrentLevelValue < 0) startUpCurrentLevelValue = 1;

                await entity.write('genLevelCtrl', {startUpCurrentLevel: startUpCurrentLevelValue}, utils.getOptions(meta.mapped, entity));

                // reverse translate number -> preset
                if (startUpCurrentLevelValue == 255) {
                    startUpCurrentLevelValue = 'previous';
                }
                if (startUpCurrentLevelValue == 0) {
                    startUpCurrentLevelValue = 'minimum';
                }
                Object.assign(state, {current_level_startup: startUpCurrentLevelValue});
            }

            if (Object.keys(state).length > 0) {
                return {state: {level_config: state}};
            }
        },
        convertGet: async (entity, key, meta) => {
            for (const attribute of ['onOffTransitionTime', 'onTransitionTime', 'offTransitionTime', 'startUpCurrentLevel']) {
                try {
                    await entity.read('genLevelCtrl', [attribute]);
                } catch (ex) {
                    // continue regardless of error, all these are optional in ZCL
                }
            }
        },
    },
    ballast_config: {
        key: ['ballast_config',
            'ballast_physical_minimum_level',
            'ballast_physical_maximum_level',
            'ballast_minimum_level',
            'ballast_maximum_level'],
        // zcl attribute names are camel case, but we want to use snake case in the outside communication
        convertSet: async (entity, key, value, meta) => {
            if (key === 'ballast_config') {
                value = utils.toCamelCase(value);
                for (const [attrName, attrValue] of Object.entries(value)) {
                    const attributes = {};
                    attributes[attrName] = attrValue;
                    await entity.write('lightingBallastCfg', attributes);
                }
            }
            if (key === 'ballast_minimum_level') {
                await entity.write('lightingBallastCfg', {'minLevel': value});
            }
            if (key === 'ballast_maximum_level') {
                await entity.write('lightingBallastCfg', {'maxLevel': value});
            }
            converters.ballast_config.convertGet(entity, key, meta);
        },
        convertGet: async (entity, key, meta) => {
            let result = {};
            for (const attrName of [
                'physical_min_level',
                'physical_max_level',
                'ballast_status',
                'min_level',
                'max_level',
                'power_on_level',
                'power_on_fade_time',
                'intrinsic_ballast_factor',
                'ballast_factor_adjustment',
                'lamp_quantity',
                'lamp_type',
                'lamp_manufacturer',
                'lamp_rated_hours',
                'lamp_burn_hours',
                'lamp_alarm_mode',
                'lamp_burn_hours_trip_point',
            ]) {
                try {
                    result = {...result, ...(await entity.read('lightingBallastCfg', [utils.toCamelCase(attrName)]))};
                } catch (ex) {
                    // continue regardless of error
                }
            }
            if (key === 'ballast_config') {
                meta.logger.warn(`ballast_config attribute results received: ${JSON.stringify(utils.toSnakeCase(result))}`);
            }
        },
    },
    light_brightness_step: {
        key: ['brightness_step', 'brightness_step_onoff'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            const onOff = key.endsWith('_onoff');
            const command = onOff ? 'stepWithOnOff' : 'step';
            value = Number(value);
            if (isNaN(value)) {
                throw new Error(`${key} value of message: '${JSON.stringify(meta.message)}' invalid`);
            }

            const mode = value > 0 ? 0 : 1;
            const transition = utils.getTransition(entity, key, meta).time;
            const payload = {stepmode: mode, stepsize: Math.abs(value), transtime: transition};
            await entity.command('genLevelCtrl', command, payload, utils.getOptions(meta.mapped, entity));

            if (meta.state.hasOwnProperty('brightness')) {
                let brightness = onOff || meta.state.state === 'ON' ? meta.state.brightness + value : meta.state.brightness;
                if (value === 0) {
                    const entityToRead = utils.getEntityOrFirstGroupMember(entity);
                    if (entityToRead) {
                        brightness = (await entityToRead.read('genLevelCtrl', ['currentLevel'])).currentLevel;
                    }
                }

                brightness = Math.min(254, brightness);
                brightness = Math.max(onOff || meta.state.state === 'OFF' ? 0 : 1, brightness);

                if (utils.getMetaValue(entity, meta.mapped, 'turnsOffAtBrightness1', 'allEqual', false)) {
                    if (onOff && value < 0 && brightness === 1) {
                        brightness = 0;
                    } else if (onOff && value > 0 && meta.state.brightness === 0) {
                        brightness++;
                    }
                }

                return {state: {brightness, state: brightness === 0 ? 'OFF' : 'ON'}};
            }
        },
    },
    light_brightness_move: {
        key: ['brightness_move', 'brightness_move_onoff'],
        convertSet: async (entity, key, value, meta) => {
            if (value === 'stop' || value === 0) {
                await entity.command('genLevelCtrl', 'stop', {}, utils.getOptions(meta.mapped, entity));

                // As we cannot determine the new brightness state, we read it from the device
                await utils.sleep(500);
                const target = utils.getEntityOrFirstGroupMember(entity);
                const onOff = (await target.read('genOnOff', ['onOff'])).onOff;
                const brightness = (await target.read('genLevelCtrl', ['currentLevel'])).currentLevel;
                return {state: {brightness, state: onOff === 1 ? 'ON' : 'OFF'}};
            } else {
                value = Number(value);
                if (isNaN(value)) {
                    throw new Error(`${key} value of message: '${JSON.stringify(meta.message)}' invalid`);
                }
                const payload = {movemode: value > 0 ? 0 : 1, rate: Math.abs(value)};
                const command = key.endsWith('onoff') ? 'moveWithOnOff' : 'move';
                await entity.command('genLevelCtrl', command, payload, utils.getOptions(meta.mapped, entity));
            }
        },
    },
    light_colortemp_step: {
        key: ['color_temp_step'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            value = Number(value);
            if (isNaN(value)) {
                throw new Error(`${key} value of message: '${JSON.stringify(meta.message)}' invalid`);
            }

            const mode = value > 0 ? 1 : 3;
            const transition = utils.getTransition(entity, key, meta).time;
            const payload = {stepmode: mode, stepsize: Math.abs(value), transtime: transition, minimum: 0, maximum: 600};
            await entity.command('lightingColorCtrl', 'stepColorTemp', payload, utils.getOptions(meta.mapped, entity));

            // We cannot determine the color temperature from the current state so we read it, because
            // - We don't know the max/min valus
            // - Color mode could have been swithed (x/y or hue/saturation)
            const entityToRead = utils.getEntityOrFirstGroupMember(entity);
            if (entityToRead) {
                await utils.sleep(100 + (transition * 100));
                await entityToRead.read('lightingColorCtrl', ['colorTemperature']);
            }
        },
    },
    light_colortemp_move: {
        key: ['colortemp_move', 'color_temp_move'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'color_temp_move' && (value === 'stop' || !isNaN(value))) {
                value = value === 'stop' ? value : Number(value);
                const payload = {minimum: 0, maximum: 600};
                if (value === 'stop' || value === 0) {
                    payload.rate = 1;
                    payload.movemode = 0;
                } else {
                    payload.rate = Math.abs(value);
                    payload.movemode = value > 0 ? 1 : 3;
                }

                await entity.command('lightingColorCtrl', 'moveColorTemp', payload, utils.getOptions(meta.mapped, entity));

                // We cannot determine the color temperaturefrom the current state so we read it, because
                // - Color mode could have been swithed (x/y or colortemp)
                if (value === 'stop' || value === 0) {
                    const entityToRead = utils.getEntityOrFirstGroupMember(entity);
                    if (entityToRead) {
                        await utils.sleep(100);
                        await entityToRead.read('lightingColorCtrl', ['colorTemperature', 'colorMode']);
                    }
                }
            } else {
                // Deprecated
                const payload = {minimum: 153, maximum: 370, rate: 55};
                const stop = (val) => ['stop', 'release', '0'].some((el) => val.includes(el));
                const up = (val) => ['1', 'up'].some((el) => val.includes(el));
                const arr = [value.toString()];
                const moverate = meta.message.hasOwnProperty('rate') ? parseInt(meta.message.rate) : 55;
                payload.rate = moverate;
                if (arr.filter(stop).length) {
                    payload.movemode = 0;
                } else {
                    payload.movemode = arr.filter(up).length ? 1 : 3;
                }
                await entity.command('lightingColorCtrl', 'moveColorTemp', payload, utils.getOptions(meta.mapped, entity));
            }
        },
    },
    light_hue_saturation_step: {
        key: ['hue_step', 'saturation_step'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            value = Number(value);
            if (isNaN(value)) {
                throw new Error(`${key} value of message: '${JSON.stringify(meta.message)}' invalid`);
            }

            const command = key === 'hue_step' ? 'stepHue' : 'stepSaturation';
            const attribute = key === 'hue_step' ? 'currentHue' : 'currentSaturation';
            const mode = value > 0 ? 1 : 3;
            const transition = utils.getTransition(entity, key, meta).time;
            const payload = {stepmode: mode, stepsize: Math.abs(value), transtime: transition};
            await entity.command('lightingColorCtrl', command, payload, utils.getOptions(meta.mapped, entity));

            // We cannot determine the hue/saturation from the current state so we read it, because
            // - Color mode could have been swithed (x/y or colortemp)
            const entityToRead = utils.getEntityOrFirstGroupMember(entity);
            if (entityToRead) {
                await utils.sleep(100 + (transition * 100));
                await entityToRead.read('lightingColorCtrl', [attribute, 'colorMode']);
            }
        },
    },
    light_hue_saturation_move: {
        key: ['hue_move', 'saturation_move'],
        convertSet: async (entity, key, value, meta) => {
            value = value === 'stop' ? value : Number(value);
            if (isNaN(value) && value !== 'stop') {
                throw new Error(`${key} value of message: '${JSON.stringify(meta.message)}' invalid`);
            }

            const command = key === 'hue_move' ? 'moveHue' : 'moveSaturation';
            const attribute = key === 'hue_move' ? 'currentHue' : 'currentSaturation';

            const payload = {};
            if (value === 'stop' || value === 0) {
                payload.rate = 1;
                payload.movemode = 0;
            } else {
                payload.rate = Math.abs(value);
                payload.movemode = value > 0 ? 1 : 3;
            }

            await entity.command('lightingColorCtrl', command, payload, utils.getOptions(meta.mapped, entity));

            // We cannot determine the hue/saturation from the current state so we read it, because
            // - Color mode could have been swithed (x/y or colortemp)
            if (value === 'stop' || value === 0) {
                const entityToRead = utils.getEntityOrFirstGroupMember(entity);
                if (entityToRead) {
                    await utils.sleep(100);
                    await entityToRead.read('lightingColorCtrl', [attribute, 'colorMode']);
                }
            }
        },
    },
    light_onoff_brightness: {
        key: ['state', 'brightness', 'brightness_percent'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            const {message} = meta;
            const transition = utils.getTransition(entity, 'brightness', meta);
            const turnsOffAtBrightness1 = utils.getMetaValue(entity, meta.mapped, 'turnsOffAtBrightness1', 'allEqual', false);
            let state = message.hasOwnProperty('state') ? message.state.toLowerCase() : undefined;
            let brightness = undefined;
            if (message.hasOwnProperty('brightness')) {
                brightness = Number(message.brightness);
            } else if (message.hasOwnProperty('brightness_percent')) {
                brightness = utils.mapNumberRange(Number(message.brightness_percent), 0, 100, 0, 255);
            }

            if (brightness !== undefined && (isNaN(brightness) || brightness < 0 || brightness > 255)) {
                // Allow 255 value, changing this to 254 would be a breaking change.
                throw new Error(`Brightness value of message: '${JSON.stringify(message)}' invalid, must be a number >= 0 and =< 254`);
            }

            if (state !== undefined && ['on', 'off', 'toggle'].includes(state) === false) {
                throw new Error(`State value of message: '${JSON.stringify(message)}' invalid, must be 'ON', 'OFF' or 'TOGGLE'`);
            }

            if (state === 'toggle' || state === 'off' || (brightness === undefined && state === 'on')) {
                if (transition.specified) {
                    if (state === 'toggle') {
                        state = meta.state.state === 'ON' ? 'off' : 'on';
                    }

                    if (state === 'off' && meta.state.brightness && meta.state.state === 'ON') {
                        // https://github.com/Koenkk/zigbee2mqtt/issues/2850#issuecomment-580365633
                        // We need to remember the state before turning the device off as we need to restore
                        // it once we turn it on again.
                        // We cannot rely on the meta.state as when reporting is enabled the bulb will reports
                        // it brightness while decreasing the brightness.
                        globalStore.putValue(entity, 'brightness', meta.state.brightness);
                        globalStore.putValue(entity, 'turnedOffWithTransition', true);
                    }

                    const fallbackLevel = utils.getObjectProperty(meta.state, 'brightness', 254);
                    let level = state === 'off' ? 0 : globalStore.getValue(entity, 'brightness', fallbackLevel);
                    if (state === 'on' && level === 0) level = turnsOffAtBrightness1 ? 2 : 1;

                    const payload = {level, transtime: transition.time};
                    await entity.command('genLevelCtrl', 'moveToLevelWithOnOff', payload, utils.getOptions(meta.mapped, entity));
                    const result = {state: {state: state.toUpperCase()}};
                    if (state === 'on') result.state.brightness = level;
                    return result;
                } else {
                    if (state === 'on' && globalStore.getValue(entity, 'turnedOffWithTransition') === true) {
                        /**
                         * In case the bulb it turned OFF with a transition and turned ON WITHOUT
                         * a transition, the brightness is not recovered as it turns on with brightness 1.
                         * https://github.com/Koenkk/zigbee-herdsman-converters/issues/1073
                         */
                        globalStore.putValue(entity, 'turnedOffWithTransition', false);
                        await entity.command(
                            'genLevelCtrl',
                            'moveToLevelWithOnOff',
                            {level: globalStore.getValue(entity, 'brightness'), transtime: 0},
                            utils.getOptions(meta.mapped, entity),
                        );
                        return {state: {state: 'ON'}, readAfterWriteTime: transition * 100};
                    } else {
                        // Store brightness where the bulb was turned off with as we need it when the bulb is turned on
                        // with transition.
                        if (meta.state.hasOwnProperty('brightness') && state === 'off') {
                            globalStore.putValue(entity, 'brightness', meta.state.brightness);
                            globalStore.putValue(entity, 'turnedOffWithTransition', false);
                        }

                        const result = await converters.on_off.convertSet(entity, 'state', state, meta);
                        result.readAfterWriteTime = 0;
                        if (result.state && result.state.state === 'ON' && meta.state.brightness === 0) {
                            result.state.brightness = 1;
                        }

                        return result;
                    }
                }
            } else {
                brightness = Math.min(254, brightness);
                if (brightness === 1 && turnsOffAtBrightness1) {
                    brightness = 2;
                }

                globalStore.putValue(entity, 'brightness', brightness);
                await entity.command(
                    'genLevelCtrl',
                    'moveToLevelWithOnOff',
                    {level: Number(brightness), transtime: transition.time},
                    utils.getOptions(meta.mapped, entity),
                );

                return {
                    state: {state: brightness === 0 ? 'OFF' : 'ON', brightness: Number(brightness)},
                    readAfterWriteTime: transition.time * 100,
                };
            }
        },
        convertGet: async (entity, key, meta) => {
            if (key === 'brightness') {
                await entity.read('genLevelCtrl', ['currentLevel']);
            } else if (key === 'state') {
                await converters.on_off.convertGet(entity, key, meta);
            }
        },
    },
    light_colortemp: {
        key: ['color_temp', 'color_temp_percent'],
        options: [exposes.options.color_sync(), exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            const [colorTempMin, colorTempMax] = light.findColorTempRange(entity, meta.logger);
            const preset = {'warmest': colorTempMax, 'warm': 454, 'neutral': 370, 'cool': 250, 'coolest': colorTempMin};

            if (key === 'color_temp_percent') {
                value = utils.mapNumberRange(value,
                    0, 100,
                    ((colorTempMin != null) ? colorTempMin : 154), ((colorTempMax != null) ? colorTempMax : 500),
                ).toString();
            }

            if (typeof value === 'string' && isNaN(value)) {
                if (value.toLowerCase() in preset) {
                    value = preset[value.toLowerCase()];
                } else {
                    throw new Error(`Unknown preset '${value}'`);
                }
            }

            value = Number(value);

            // ensure value within range
            value = light.clampColorTemp(value, colorTempMin, colorTempMax, meta.logger);

            const payload = {colortemp: value, transtime: utils.getTransition(entity, key, meta).time};
            await entity.command('lightingColorCtrl', 'moveToColorTemp', payload, utils.getOptions(meta.mapped, entity));
            return {
                state: libColor.syncColorState({'color_mode': constants.colorMode[2], 'color_temp': value}, meta.state,
                    entity, meta.options, meta.logger), readAfterWriteTime: payload.transtime * 100,
            };
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', ['colorMode', 'colorTemperature']);
        },
    },
    light_colortemp_startup: {
        key: ['color_temp_startup'],
        convertSet: async (entity, key, value, meta) => {
            const [colorTempMin, colorTempMax] = light.findColorTempRange(entity, meta.logger);
            const preset = {'warmest': colorTempMax, 'warm': 454, 'neutral': 370, 'cool': 250, 'coolest': colorTempMin, 'previous': 65535};

            if (typeof value === 'string' && isNaN(value)) {
                if (value.toLowerCase() in preset) {
                    value = preset[value.toLowerCase()];
                } else {
                    throw new Error(`Unknown preset '${value}'`);
                }
            }

            value = Number(value);

            // ensure value within range
            // we do allow one exception for 0xffff, which is to restore the previous value
            if (value != 65535) {
                value = light.clampColorTemp(value, colorTempMin, colorTempMax, meta.logger);
            }

            await entity.write('lightingColorCtrl', {startUpColorTemperature: value}, utils.getOptions(meta.mapped, entity));
            return {state: {color_temp_startup: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', ['startUpColorTemperature']);
        },
    },
    light_color: {
        key: ['color'],
        options: [exposes.options.color_sync(), exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            let command;
            const newColor = libColor.Color.fromConverterArg(value);
            const newState = {};

            const zclData = {transtime: utils.getTransition(entity, key, meta).time};

            if (newColor.isRGB() || newColor.isXY()) {
                // Convert RGB to XY color mode because Zigbee doesn't support RGB (only x/y and hue/saturation)
                const xy = newColor.isRGB() ? newColor.rgb.gammaCorrected().toXY().rounded(4) : newColor.xy;

                // Some bulbs e.g. RB 185 C don't turn to red (they don't respond at all) when x: 0.701 and y: 0.299
                // is send. These values are e.g. send by Home Assistant when clicking red in the color wheel.
                // If we slighlty modify these values the bulb will respond.
                // https://github.com/home-assistant/home-assistant/issues/31094
                if (utils.getMetaValue(entity, meta.mapped, 'applyRedFix', 'allEqual', false) && xy.x == 0.701 && xy.y === 0.299) {
                    xy.x = 0.7006;
                    xy.y = 0.2993;
                }

                newState.color_mode = constants.colorMode[1];
                newState.color = xy.toObject();
                zclData.colorx = utils.mapNumberRange(xy.x, 0, 1, 0, 65535);
                zclData.colory = utils.mapNumberRange(xy.y, 0, 1, 0, 65535);
                command = 'moveToColor';
            } else if (newColor.isHSV()) {
                const enhancedHue = utils.getMetaValue(entity, meta.mapped, 'enhancedHue', 'allEqual', true);
                const hsv = newColor.hsv;
                const hsvCorrected = hsv.colorCorrected(meta);
                newState.color_mode = constants.colorMode[0];
                newState.color = hsv.toObject(false);

                if (hsv.hue !== null) {
                    if (enhancedHue) {
                        zclData.enhancehue = utils.mapNumberRange(hsvCorrected.hue, 0, 360, 0, 65535);
                    } else {
                        zclData.hue = utils.mapNumberRange(hsvCorrected.hue, 0, 360, 0, 254);
                    }
                    zclData.direction = value.direction || 0;
                }

                if (hsv.saturation != null) {
                    zclData.saturation = utils.mapNumberRange(hsvCorrected.saturation, 0, 100, 0, 254);
                }

                if (hsv.value !== null) {
                    // fallthrough to genLevelCtrl
                    value.brightness = utils.mapNumberRange(hsvCorrected.value, 0, 100, 0, 254);
                }

                if (hsv.hue !== null && hsv.saturation !== null) {
                    if (enhancedHue) {
                        command = 'enhancedMoveToHueAndSaturation';
                    } else {
                        command = 'moveToHueAndSaturation';
                    }
                } else if (hsv.hue !== null) {
                    if (enhancedHue) {
                        command = 'enhancedMoveToHue';
                    } else {
                        command = 'moveToHue';
                    }
                } else if (hsv.saturation !== null) {
                    command = 'moveToSaturation';
                }
            }

            if (value.hasOwnProperty('brightness')) {
                await entity.command(
                    'genLevelCtrl',
                    'moveToLevelWithOnOff',
                    {level: Number(value.brightness), transtime: utils.getTransition(entity, key, meta).time},
                    utils.getOptions(meta.mapped, entity),
                );
            }

            await entity.command('lightingColorCtrl', command, zclData, utils.getOptions(meta.mapped, entity));
            return {state: libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger),
                readAfterWriteTime: zclData.transtime * 100};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', light.readColorAttributes(entity, meta));
        },
    },
    light_color_colortemp: {
        /**
         * This converter is a combination of light_color and light_colortemp and
         * can be used instead of the two individual converters. When used to set,
         * it actually calls out to light_color or light_colortemp to get the
         * return value. When used to get, it gets both color and colorTemp in
         * one call.
         * The reason for the existence of this somewhat peculiar converter is
         * that some lights don't report their state when changed. To fix this,
         * we query the state after we set it. We want to query color and colorTemp
         * both when setting either, because both change when setting one. This
         * converter is used to do just that.
         */
        key: ['color', 'color_temp', 'color_temp_percent'],
        options: [exposes.options.color_sync(), exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (key == 'color') {
                const result = await converters.light_color.convertSet(entity, key, value, meta);
                return result;
            } else if (key == 'color_temp' || key == 'color_temp_percent') {
                const result = await converters.light_colortemp.convertSet(entity, key, value, meta);
                return result;
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', light.readColorAttributes(entity, meta, ['colorTemperature']));
        },
    },
    effect: {
        key: ['effect', 'alert', 'flash'], // alert and flash are deprecated.
        convertSet: async (entity, key, value, meta) => {
            if (key === 'effect') {
                const lookup = {blink: 0, breathe: 1, okay: 2, channel_change: 11, finish_effect: 254, stop_effect: 255};
                value = value.toLowerCase();
                utils.validateValue(value, Object.keys(lookup));
                const payload = {effectid: lookup[value], effectvariant: 0};
                await entity.command('genIdentify', 'triggerEffect', payload, utils.getOptions(meta.mapped, entity));
            } else if (key === 'alert' || key === 'flash') { // Deprecated
                let effectid = 0;
                const lookup = {'select': 0x00, 'lselect': 0x01, 'none': 0xFF};
                if (key === 'flash') {
                    if (value === 2) {
                        value = 'select';
                    } else if (value === 10) {
                        value = 'lselect';
                    }
                }

                effectid = lookup[value];
                const payload = {effectid, effectvariant: 0};
                await entity.command('genIdentify', 'triggerEffect', payload, utils.getOptions(meta.mapped, entity));
            }
        },
    },
    thermostat_remote_sensing: {
        key: ['remote_sensing'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {remoteSensing: value});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['remoteSensing']);
        },
    },
    thermostat_weekly_schedule: {
        key: ['weekly_schedule'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {
                numoftrans: value.numoftrans,
                dayofweek: value.dayofweek,
                mode: value.mode,
                transitions: value.transitions,
            };
            for (const elem of payload['transitions']) {
                if (typeof elem['heatSetpoint'] == 'number') {
                    elem['heatSetpoint'] = Math.round(elem['heatSetpoint'] * 100);
                }
                if (typeof elem['coolSetpoint'] == 'number') {
                    elem['coolSetpoint'] = Math.round(elem['coolSetpoint'] * 100);
                }
            }
            await entity.command('hvacThermostat', 'setWeeklySchedule', payload, utils.getOptions(meta.mapped, entity));
        },
        convertGet: async (entity, key, meta) => {
            const payload = {
                daystoreturn: 0xff, // Sun-Sat and vacation
                modetoreturn: 3, // heat + cool
            };
            await entity.command('hvacThermostat', 'getWeeklySchedule', payload, utils.getOptions(meta.mapped, entity));
        },
    },
    thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            let systemMode = utils.getKey(constants.thermostatSystemModes, value, undefined, Number);
            if (systemMode === undefined) {
                systemMode = utils.getKey(legacy.thermostatSystemModes, value, value, Number);
            }
            await entity.write('hvacThermostat', {systemMode});
            return {readAfterWriteTime: 250, state: {system_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['systemMode']);
        },
    },
    thermostat_control_sequence_of_operation: {
        key: ['control_sequence_of_operation'],
        convertSet: async (entity, key, value, meta) => {
            let val = utils.getKey(constants.thermostatControlSequenceOfOperations, value, undefined, Number);
            if (val === undefined) {
                val = utils.getKey(constants.thermostatControlSequenceOfOperations, value, value, Number);
            }
            await entity.write('hvacThermostat', {ctrlSeqeOfOper: val});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['ctrlSeqeOfOper']);
        },
    },
    thermostat_programming_operation_mode: {
        key: ['programming_operation_mode'],
        convertSet: async (entity, key, value, meta) => {
            const val = utils.getKey(constants.thermostatProgrammingOperationModes, value, undefined, Number);
            if (val === undefined) {
                throw new Error('Programming operation mode invalid, must be one of: ' +
                    Object.values(constants.thermostatProgrammingOperationModes).join(', '));
            }
            await entity.write('hvacThermostat', {programingOperMode: val});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['programingOperMode']);
        },
    },
    thermostat_temperature_display_mode: {
        key: ['temperature_display_mode'],
        convertSet: async (entity, key, value, meta) => {
            const tempDisplayMode = utils.getKey(constants.temperatureDisplayMode, value, value, Number);
            await entity.write('hvacUserInterfaceCfg', {tempDisplayMode});
        },
    },
    thermostat_keypad_lockout: {
        key: ['keypad_lockout'],
        convertSet: async (entity, key, value, meta) => {
            const keypadLockout = utils.getKey(constants.keypadLockoutMode, value, value, Number);
            await entity.write('hvacUserInterfaceCfg', {keypadLockout});
            return {readAfterWriteTime: 250, state: {keypad_lockout: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacUserInterfaceCfg', ['keypadLockout']);
        },
    },
    thermostat_temperature_setpoint_hold: {
        key: ['temperature_setpoint_hold'],
        convertSet: async (entity, key, value, meta) => {
            const tempSetpointHold = value;
            await entity.write('hvacThermostat', {tempSetpointHold});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['tempSetpointHold']);
        },
    },
    thermostat_temperature_setpoint_hold_duration: {
        key: ['temperature_setpoint_hold_duration'],
        convertSet: async (entity, key, value, meta) => {
            const tempSetpointHoldDuration = value;
            await entity.write('hvacThermostat', {tempSetpointHoldDuration});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['tempSetpointHoldDuration']);
        },
    },
    fan_mode: {
        key: ['fan_mode', 'fan_state'],
        convertSet: async (entity, key, value, meta) => {
            if (key == 'fan_state' && value.toLowerCase() == 'on') {
                value = utils.getMetaValue(entity, meta.mapped, 'fanStateOn', 'allEqual', 'on');
            }
            const fanMode = constants.fanMode[value.toLowerCase()];
            await entity.write('hvacFanCtrl', {fanMode});
            return {state: {fan_mode: value.toLowerCase(), fan_state: value.toLowerCase() === 'off' ? 'OFF' : 'ON'}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacFanCtrl', ['fanMode']);
        },
    },
    thermostat_local_temperature: {
        key: ['local_temperature'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['localTemp']);
        },
    },
    thermostat_local_temperature_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {localTemperatureCalibration: Math.round(value * 10)});
            return {state: {local_temperature_calibration: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['localTemperatureCalibration']);
        },
    },
    thermostat_occupancy: {
        key: ['occupancy'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['ocupancy']);
        },
    },
    thermostat_clear_weekly_schedule: {
        key: ['clear_weekly_schedule'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command('hvacThermostat', 'clearWeeklySchedule', {}, utils.getOptions(meta.mapped, entity));
        },
    },
    thermostat_pi_heating_demand: {
        key: ['pi_heating_demand'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['pIHeatingDemand']);
        },
    },
    thermostat_running_state: {
        key: ['running_state'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['runningState']);
        },
    },
    thermostat_occupied_heating_setpoint: {
        key: ['occupied_heating_setpoint'],
        options: [exposes.options.thermostat_unit()],
        convertSet: async (entity, key, value, meta) => {
            let result;
            if (meta.options.thermostat_unit === 'fahrenheit') {
                result = Math.round(utils.normalizeCelsiusVersionOfFahrenheit(value) * 100);
            } else {
                result = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            }
            const occupiedHeatingSetpoint = result;
            await entity.write('hvacThermostat', {occupiedHeatingSetpoint});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['occupiedHeatingSetpoint']);
        },
    },
    thermostat_unoccupied_heating_setpoint: {
        key: ['unoccupied_heating_setpoint'],
        options: [exposes.options.thermostat_unit()],
        convertSet: async (entity, key, value, meta) => {
            let result;
            if (meta.options.thermostat_unit === 'fahrenheit') {
                result = Math.round(utils.normalizeCelsiusVersionOfFahrenheit(value) * 100);
            } else {
                result = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            }
            const unoccupiedHeatingSetpoint = result;
            await entity.write('hvacThermostat', {unoccupiedHeatingSetpoint});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['unoccupiedHeatingSetpoint']);
        },
    },
    thermostat_occupied_cooling_setpoint: {
        key: ['occupied_cooling_setpoint'],
        options: [exposes.options.thermostat_unit()],
        convertSet: async (entity, key, value, meta) => {
            let result;
            if (meta.options.thermostat_unit === 'fahrenheit') {
                result = Math.round(utils.normalizeCelsiusVersionOfFahrenheit(value) * 100);
            } else {
                result = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            }
            const occupiedCoolingSetpoint = result;
            await entity.write('hvacThermostat', {occupiedCoolingSetpoint});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['occupiedCoolingSetpoint']);
        },
    },
    thermostat_unoccupied_cooling_setpoint: {
        key: ['unoccupied_cooling_setpoint'],
        options: [exposes.options.thermostat_unit()],
        convertSet: async (entity, key, value, meta) => {
            let result;
            if (meta.options.thermostat_unit === 'fahrenheit') {
                result = Math.round(utils.normalizeCelsiusVersionOfFahrenheit(value) * 100);
            } else {
                result = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            }
            const unoccupiedCoolingSetpoint = result;
            await entity.write('hvacThermostat', {unoccupiedCoolingSetpoint});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['unoccupiedCoolingSetpoint']);
        },
    },
    thermostat_setpoint_raise_lower: {
        key: ['setpoint_raise_lower'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {mode: value.mode, amount: Math.round(value.amount) * 100};
            await entity.command('hvacThermostat', 'setpointRaiseLower', payload, utils.getOptions(meta.mapped, entity));
        },
    },
    thermostat_relay_status_log: {
        key: ['relay_status_log'],
        convertGet: async (entity, key, meta) => {
            await entity.command('hvacThermostat', 'getRelayStatusLog', {}, utils.getOptions(meta.mapped, entity));
        },
    },
    thermostat_running_mode: {
        key: ['running_mode'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['runningMode']);
        },
    },
    thermostat_min_heat_setpoint_limit: {
        key: ['min_heat_setpoint_limit'],
        convertSet: async (entity, key, value, meta) => {
            let result;
            if (meta.options.thermostat_unit === 'fahrenheit') {
                result = Math.round(utils.normalizeCelsiusVersionOfFahrenheit(value) * 100);
            } else {
                result = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            }
            const minHeatSetpointLimit = result;
            await entity.write('hvacThermostat', {minHeatSetpointLimit});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['minHeatSetpointLimit']);
        },
    },
    thermostat_max_heat_setpoint_limit: {
        key: ['max_heat_setpoint_limit'],
        convertSet: async (entity, key, value, meta) => {
            let result;
            if (meta.options.thermostat_unit === 'fahrenheit') {
                result = Math.round(utils.normalizeCelsiusVersionOfFahrenheit(value) * 100);
            } else {
                result = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            }
            const maxHeatSetpointLimit = result;
            await entity.write('hvacThermostat', {maxHeatSetpointLimit});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['maxHeatSetpointLimit']);
        },
    },
    thermostat_ac_louver_position: {
        key: ['ac_louver_position'],
        convertSet: async (entity, key, value, meta) => {
            let acLouverPosition = utils.getKey(constants.thermostatAcLouverPositions, value, undefined, Number);
            if (acLouverPosition === undefined) {
                acLouverPosition = utils.getKey(constants.thermostatAcLouverPositions, value, value, Number);
            }
            await entity.write('hvacThermostat', {acLouverPosition});
            return {state: {ac_louver_position: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['acLouverPosition']);
        },
    },
    electrical_measurement_power: {
        key: ['power'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haElectricalMeasurement', ['activePower']);
        },
    },
    metering_power: {
        key: ['power'],
        convertGet: async (entity, key, meta) => {
            await entity.read('seMetering', ['instantaneousDemand']);
        },
    },
    currentsummdelivered: {
        key: ['energy'],
        convertGet: async (entity, key, meta) => {
            await entity.read('seMetering', ['currentSummDelivered']);
        },
    },
    frequency: {
        key: ['ac_frequency'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haElectricalMeasurement', ['acFrequency']);
        },
    },
    powerfactor: {
        key: ['power_factor'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haElectricalMeasurement', ['powerFactor']);
        },
    },
    acvoltage: {
        key: ['voltage'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haElectricalMeasurement', ['rmsVoltage']);
        },
    },
    accurrent: {
        key: ['current'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haElectricalMeasurement', ['rmsCurrent']);
        },
    },
    temperature: {
        key: ['temperature'],
        convertGet: async (entity, key, meta) => {
            await entity.read('msTemperatureMeasurement', ['measuredValue']);
        },
    },
    // #endregion

    // #region Non-generic converters
    elko_load: {
        key: ['load'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoLoad': value});
            return {state: {load: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoLoad']);
        },
    },
    elko_display_text: {
        key: ['display_text'],
        convertSet: async (entity, key, value, meta) => {
            if (value.length <= 14) {
                await entity.write('hvacThermostat', {'elkoDisplayText': value});
                return {state: {display_text: value}};
            } else {
                throw new Error('Length of text is greater than 14');
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoDisplayText']);
        },
    },
    elko_power_status: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoPowerStatus': value === 'heat'});
            return {state: {system_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoPowerStatus']);
        },
    },
    elko_external_temp: {
        key: ['floor_temp'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoExternalTemp']);
        },
    },
    elko_mean_power: {
        key: ['mean_power'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoMeanPower']);
        },
    },
    elko_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoChildLock': value === 'lock'});
            return {state: {child_lock: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoChildLock']);
        },
    },
    elko_frost_guard: {
        key: ['frost_guard'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoFrostGuard': value === 'on'});
            return {state: {frost_guard: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoFrostGuard']);
        },
    },
    elko_night_switching: {
        key: ['night_switching'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoNightSwitching': value === 'on'});
            return {state: {night_switching: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoNightSwitching']);
        },
    },
    elko_relay_state: {
        key: ['running_state'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoRelayState']);
        },
    },
    elko_sensor_mode: {
        key: ['sensor'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoSensor': {'air': '0', 'floor': '1', 'supervisor_floor': '3'}[value]});
            return {state: {sensor: value}};
        },
    },
    elko_regulator_time: {
        key: ['regulator_time'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoRegulatorTime': value});
            return {state: {sensor: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoRegulatorTime']);
        },
    },
    elko_regulator_mode: {
        key: ['regulator_mode'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoRegulatorMode': value === 'regulator'});
            return {state: {regulator_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoRegulatorMode']);
        },
    },
    elko_local_temperature_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'elkoCalibration': Math.round(value * 10)});
            return {state: {local_temperature_calibration: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoCalibration']);
        },
    },
    elko_max_floor_temp: {
        key: ['max_floor_temp'],
        convertSet: async (entity, key, value, meta) => {
            if (value.length <= 14) {
                await entity.write('hvacThermostat', {'elkoMaxFloorTemp': value});
                return {state: {max_floor_temp: value}};
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['elkoMaxFloorTemp']);
        },
    },
    livolo_socket_switch_on_off: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'string') {
                return;
            }

            const state = value.toLowerCase();
            const postfix = meta.endpoint_name || 'left';
            await entity.command('genOnOff', 'toggle', {}, {transactionSequenceNumber: 0});
            const payloadOn = {0x0001: {value: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), type: 1}};
            const payloadOff = {0x0001: {value: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), type: 1}};
            const payloadOnRight = {0x0001: {value: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]), type: 2}};
            const payloadOffRight = {0x0001: {value: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), type: 2}};
            if (postfix === 'left') {
                await entity.write('genPowerCfg', (state === 'on') ? payloadOn : payloadOff,
                    {
                        manufacturerCode: 0x1ad2, disableDefaultResponse: true, disableResponse: true,
                        reservedBits: 3, direction: 1, transactionSequenceNumber: 0xe9,
                    });
                return {state: {state_left: value.toUpperCase()}, readAfterWriteTime: 250};
            } else if (postfix === 'right') {
                await entity.write('genPowerCfg', (state === 'on') ? payloadOnRight : payloadOffRight,
                    {
                        manufacturerCode: 0x1ad2, disableDefaultResponse: true, disableResponse: true,
                        reservedBits: 3, direction: 1, transactionSequenceNumber: 0xe9,
                    });
                return {state: {state_right: value.toUpperCase()}, readAfterWriteTime: 250};
            }
            return {state: {state: value.toUpperCase()}, readAfterWriteTime: 250};
        },
        convertGet: async (entity, key, meta) => {
            await entity.command('genOnOff', 'toggle', {}, {transactionSequenceNumber: 0});
        },
    },
    livolo_switch_on_off: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'string') {
                return;
            }

            const postfix = meta.endpoint_name || 'left';
            let state = value.toLowerCase();
            let channel = 1;

            if (state === 'on') {
                state = 108;
            } else if (state === 'off') {
                state = 1;
            } else {
                return;
            }

            if (postfix === 'left') {
                channel = 1.0;
            } else if (postfix === 'right') {
                channel = 2.0;
            } else {
                return;
            }

            await entity.command('genLevelCtrl', 'moveToLevelWithOnOff', {level: state, transtime: channel});
            return {state: {state: value.toUpperCase()}, readAfterWriteTime: 250};
        },
        convertGet: async (entity, key, meta) => {
            await entity.command('genOnOff', 'toggle', {}, {transactionSequenceNumber: 0});
        },
    },
    livolo_dimmer_level: {
        key: ['brightness', 'brightness_percent', 'level'],
        convertSet: async (entity, key, value, meta) => {
            // upscale to 100
            value = Number(value);
            let newValue;
            if (key === 'level') {
                if (value >= 0 && value <= 1000) {
                    newValue = utils.mapNumberRange(value, 0, 1000, 0, 100);
                } else {
                    throw new Error('Dimmer level is out of range 0..1000');
                }
            } else if (key === 'brightness_percent') {
                if (value >= 0 && value <= 100) {
                    newValue = Math.round(value);
                } else {
                    throw new Error('Dimmer brightness_percent is out of range 0..100');
                }
            } else {
                if (value >= 0 && value <= 255) {
                    newValue = utils.mapNumberRange(value, 0, 255, 0, 100);
                } else {
                    throw new Error('Dimmer brightness is out of range 0..255');
                }
            }
            await entity.command('genOnOff', 'toggle', {}, {transactionSequenceNumber: 0});
            const payload = {0x0301: {value: Buffer.from([newValue, 0, 0, 0, 0, 0, 0, 0]), type: 1}};
            await entity.write('genPowerCfg', payload,
                {
                    manufacturerCode: 0x1ad2, disableDefaultResponse: true, disableResponse: true,
                    reservedBits: 3, direction: 1, transactionSequenceNumber: 0xe9, writeUndiv: true,
                });
            return {
                state: {brightness_percent: newValue, brightness: utils.mapNumberRange(newValue, 0, 100, 0, 255), level: (newValue * 10)},
                readAfterWriteTime: 250,
            };
        },
        convertGet: async (entity, key, meta) => {
            await entity.command('genOnOff', 'toggle', {}, {transactionSequenceNumber: 0});
        },
    },
    livolo_cover_state: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            let payload;
            const options = {
                frameType: 0, manufacturerCode: 0x1ad2, disableDefaultResponse: true,
                disableResponse: true, reservedBits: 3, direction: 1, writeUndiv: true,
                transactionSequenceNumber: 0xe9,
            };
            switch (value) {
            case 'OPEN':
                payload =
                    {attrId: 0x0000, selector: null, elementData: [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]};
                break;
            case 'CLOSE':
                payload =
                    {attrId: 0x0000, selector: null, elementData: [0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]};
                break;
            case 'STOP':
                payload =
                    {attrId: 0x0000, selector: null, elementData: [0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]};
                break;
            default:
                throw new Error(`Value '${value}' is not a valid cover position (must be one of 'OPEN' or 'CLOSE')`);
            }
            await entity.writeStructured('genPowerCfg', [payload], options);
            return {
                state: {
                    moving: true,
                },
                readAfterWriteTime: 250,
            };
        },
    },
    livolo_cover_position: {
        key: ['position'],
        convertSet: async (entity, key, value, meta) => {
            const position = 100 - value;
            await entity.command('genOnOff', 'toggle', {}, {transactionSequenceNumber: 0});
            const payload = {0x0401: {value: [position, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], type: 1}};
            await entity.write('genPowerCfg', payload,
                {
                    manufacturerCode: 0x1ad2, disableDefaultResponse: true, disableResponse: true,
                    reservedBits: 3, direction: 1, transactionSequenceNumber: 0xe9, writeUndiv: true,
                });
            return {
                state: {
                    position: value,
                    moving: true,
                },
                readAfterWriteTime: 250,
            };
        },
    },
    livolo_cover_options: {
        key: ['options'],
        convertSet: async (entity, key, value, meta) => {
            const options = {
                frameType: 0, manufacturerCode: 0x1ad2, disableDefaultResponse: true,
                disableResponse: true, reservedBits: 3, direction: 1, writeUndiv: true,
                transactionSequenceNumber: 0xe9,
            };

            if (value.hasOwnProperty('motor_direction')) {
                let direction;
                switch (value.motor_direction) {
                case 'FORWARD':
                    direction = 0x00;
                    break;
                case 'REVERSE':
                    direction = 0x80;
                    break;
                default:
                    throw new Error(`livolo_cover_options: ${value.motor_direction} is not a valid motor direction \
                     (must be one of 'FORWARD' or 'REVERSE')`);
                }

                const payload =
                    {0x1301: {value: [direction, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]}};
                await entity.write('genPowerCfg', payload, options);
            }

            if (value.hasOwnProperty('motor_speed')) {
                if (value.motor_speed < 20 || value.motor_speed > 40) {
                    throw new Error('livolo_cover_options: Motor speed is out of range (20-40)');
                }
                const payload =
                    {0x1201: {value: [value.motor_speed, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]}};
                await entity.write('genPowerCfg', payload, options);
            }
        },
    },
    gledopto_light_onoff_brightness: {
        key: ['state', 'brightness', 'brightness_percent'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (meta.message && meta.message.hasOwnProperty('transition')) {
                meta.message.transition = meta.message.transition * 3.3;
            }

            if (meta.mapped.model === 'GL-S-007ZS' || meta.mapped.model === 'GL-C-009') {
                // https://github.com/Koenkk/zigbee2mqtt/issues/2757
                // Device doesn't support ON with moveToLevelWithOnOff command
                if (meta.message.hasOwnProperty('state') && meta.message.state.toLowerCase() === 'on') {
                    await converters.on_off.convertSet(entity, key, 'ON', meta);
                    await utils.sleep(1000);
                }
            }

            return await converters.light_onoff_brightness.convertSet(entity, key, value, meta);
        },
        convertGet: async (entity, key, meta) => {
            return await converters.light_onoff_brightness.convertGet(entity, key, meta);
        },
    },
    gledopto_light_colortemp: {
        key: ['color_temp', 'color_temp_percent'],
        options: [exposes.options.color_sync(), exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (meta.message && meta.message.hasOwnProperty('transition')) {
                meta.message.transition = meta.message.transition * 3.3;
            }

            // Gledopto devices turn ON when they are OFF and color is set.
            // https://github.com/Koenkk/zigbee2mqtt/issues/3509
            const state = {state: 'ON'};

            const result = await converters.light_colortemp.convertSet(entity, key, value, meta);
            result.state = {...result.state, ...state};
            return result;
        },
        convertGet: async (entity, key, meta) => {
            return await converters.light_colortemp.convertGet(entity, key, meta);
        },
    },
    gledopto_light_color: {
        key: ['color'],
        options: [exposes.options.color_sync(), exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (meta.message && meta.message.hasOwnProperty('transition')) {
                meta.message.transition = meta.message.transition * 3.3;
            }

            if (key === 'color' && !meta.message.transition) {
                // Always provide a transition when setting color, otherwise CCT to RGB
                // doesn't work properly (CCT leds stay on).
                meta.message.transition = 0.4;
            }

            // Gledopto devices turn ON when they are OFF and color is set.
            // https://github.com/Koenkk/zigbee2mqtt/issues/3509
            const state = {state: 'ON'};
            const result = await converters.light_color.convertSet(entity, key, value, meta);
            result.state = {...result.state, ...state};
            return result;
        },
        convertGet: async (entity, key, meta) => {
            return await converters.light_color.convertGet(entity, key, meta);
        },
    },
    gledopto_light_color_colortemp: {
        key: ['color', 'color_temp', 'color_temp_percent'],
        options: [exposes.options.color_sync(), exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (key == 'color') {
                const result = await converters.gledopto_light_color.convertSet(entity, key, value, meta);
                if (result.state && result.state.color.hasOwnProperty('x') && result.state.color.hasOwnProperty('y')) {
                    result.state.color_temp = Math.round(libColor.ColorXY.fromObject(result.state.color).toMireds());
                }

                return result;
            } else if (key == 'color_temp' || key == 'color_temp_percent') {
                const result = await converters.gledopto_light_colortemp.convertSet(entity, key, value, meta);
                result.state.color = libColor.ColorXY.fromMireds(result.state.color_temp).rounded(4).toObject();
                return result;
            }
        },
        convertGet: async (entity, key, meta) => {
            return await converters.light_color_colortemp.convertGet(entity, key, meta);
        },
    },
    hue_power_on_behavior: {
        key: ['hue_power_on_behavior'],
        convertSet: async (entity, key, value, meta) => {
            if (value === 'default') {
                value = 'on';
            }

            let supports = {colorTemperature: false, colorXY: false};
            if (entity.constructor.name === 'Endpoint' && entity.supportsInputCluster('lightingColorCtrl')) {
                const readResult = await entity.read('lightingColorCtrl', ['colorCapabilities']);
                supports = {
                    colorTemperature: (readResult.colorCapabilities & 1 << 4) > 0,
                    colorXY: (readResult.colorCapabilities & 1 << 3) > 0,
                };
            } else if (entity.constructor.name === 'Group') {
                supports = {colorTemperature: true, colorXY: true};
            }

            if (value === 'off') {
                await entity.write('genOnOff', {0x4003: {value: 0x00, type: 0x30}});
            } else if (value === 'recover') {
                await entity.write('genOnOff', {0x4003: {value: 0xff, type: 0x30}});
                await entity.write('genLevelCtrl', {0x4000: {value: 0xff, type: 0x20}});

                if (supports.colorTemperature) {
                    await entity.write('lightingColorCtrl', {0x4010: {value: 0xffff, type: 0x21}});
                }

                if (supports.colorXY) {
                    await entity.write('lightingColorCtrl', {0x0003: {value: 0xffff, type: 0x21}}, manufacturerOptions.hue);
                    await entity.write('lightingColorCtrl', {0x0004: {value: 0xffff, type: 0x21}}, manufacturerOptions.hue);
                }
            } else if (value === 'on') {
                await entity.write('genOnOff', {0x4003: {value: 0x01, type: 0x30}});

                let brightness = meta.message.hasOwnProperty('hue_power_on_brightness') ?
                    meta.message.hue_power_on_brightness : 0xfe;
                if (brightness === 255) {
                    // 255 (0xFF) is the value for recover, therefore set it to 254 (0xFE)
                    brightness = 254;
                }
                await entity.write('genLevelCtrl', {0x4000: {value: brightness, type: 0x20}});

                if (entity.supportsInputCluster('lightingColorCtrl')) {
                    if (
                        meta.message.hasOwnProperty('hue_power_on_color_temperature') &&
                        meta.message.hasOwnProperty('hue_power_on_color')
                    ) {
                        meta.logger.error(`Provide either color temperature or color, not both`);
                    } else if (meta.message.hasOwnProperty('hue_power_on_color_temperature')) {
                        const colortemp = meta.message.hue_power_on_color_temperature;
                        await entity.write('lightingColorCtrl', {0x4010: {value: colortemp, type: 0x21}});
                        // Set color to default
                        if (supports.colorXY) {
                            await entity.write('lightingColorCtrl', {0x0003: {value: 0xFFFF, type: 0x21}}, manufacturerOptions.hue);
                            await entity.write('lightingColorCtrl', {0x0004: {value: 0xFFFF, type: 0x21}}, manufacturerOptions.hue);
                        }
                    } else if (meta.message.hasOwnProperty('hue_power_on_color')) {
                        const colorXY = libColor.ColorRGB.fromHex(meta.message.hue_power_on_color).toXY();
                        value = {x: utils.mapNumberRange(colorXY.x, 0, 1, 0, 65535), y: utils.mapNumberRange(colorXY.y, 0, 1, 0, 65535)};

                        // Set colortemp to default
                        if (supports.colorTemperature) {
                            await entity.write('lightingColorCtrl', {0x4010: {value: 366, type: 0x21}});
                        }

                        await entity.write('lightingColorCtrl', {0x0003: {value: value.x, type: 0x21}}, manufacturerOptions.hue);
                        await entity.write('lightingColorCtrl', {0x0004: {value: value.y, type: 0x21}}, manufacturerOptions.hue);
                    } else {
                        // Set defaults for colortemp and color
                        if (supports.colorTemperature) {
                            await entity.write('lightingColorCtrl', {0x4010: {value: 366, type: 0x21}});
                        }

                        if (supports.colorXY) {
                            await entity.write('lightingColorCtrl', {0x0003: {value: 0xFFFF, type: 0x21}}, manufacturerOptions.hue);
                            await entity.write('lightingColorCtrl', {0x0004: {value: 0xFFFF, type: 0x21}}, manufacturerOptions.hue);
                        }
                    }
                }
            }

            return {state: {hue_power_on_behavior: value}};
        },
    },
    hue_power_on_error: {
        key: ['hue_power_on_brightness', 'hue_power_on_color_temperature', 'hue_power_on_color'],
        convertSet: async (entity, key, value, meta) => {
            if (!meta.message.hasOwnProperty('hue_power_on_behavior')) {
                throw new Error(`Provide a value for 'hue_power_on_behavior'`);
            }
        },
    },
    hue_motion_sensitivity: {
        // motion detect sensitivity, philips specific
        key: ['motion_sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            // hue_sml:
            // 0: low, 1: medium, 2: high (default)
            // make sure you write to second endpoint!
            const lookup = {'low': 0, 'medium': 1, 'high': 2};
            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));

            const payload = {48: {value: lookup[value], type: 32}};
            await entity.write('msOccupancySensing', payload, manufacturerOptions.hue);
            return {state: {motion_sensitivity: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('msOccupancySensing', [48], manufacturerOptions.hue);
        },
    },
    hue_motion_led_indication: {
        key: ['led_indication'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {0x0033: {value, type: 0x10}};
            await entity.write('genBasic', payload, manufacturerOptions.hue);
            return {state: {led_indication: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genBasic', [0x0033], manufacturerOptions.hue);
        },
    },
    RTCGQ13LM_motion_sensitivity: {
        key: ['motion_sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'low': 1, 'medium': 2, 'high': 3};
            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));
            await entity.write('aqaraOpple', {0x010c: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {motion_sensitivity: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x010c], manufacturerOptions.xiaomi);
        },
    },
    RTCZCGQ11LM_presence: {
        key: ['presence'],
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0142], manufacturerOptions.xiaomi);
        },
    },
    RTCZCGQ11LM_monitoring_mode: {
        key: ['monitoring_mode'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'undirected': 0, 'left_right': 1};
            await entity.write('aqaraOpple', {0x0144: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {monitoring_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0144], manufacturerOptions.xiaomi);
        },
    },
    RTCZCGQ11LM_approach_distance: {
        key: ['approach_distance'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'far': 0, 'medium': 1, 'near': 2};
            await entity.write('aqaraOpple', {0x0146: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {approach_distance: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0146], manufacturerOptions.xiaomi);
        },
    },
    ZigUP_lock: {
        key: ['led'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'off': 'lockDoor', 'on': 'unlockDoor', 'toggle': 'toggleDoor'};
            await entity.command('closuresDoorLock', lookup[value], {'pincodevalue': ''});
        },
    },
    LS21001_alert_behaviour: {
        key: ['alert_behaviour'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'siren_led': 3, 'siren': 2, 'led': 1, 'nothing': 0};
            await entity.write('genBasic', {0x400a: {value: lookup[value], type: 32}},
                {manufacturerCode: 0x1168, disableDefaultResponse: true, sendWhen: 'active'});
            return {state: {alert_behaviour: value}};
        },
    },
    xiaomi_switch_type: {
        key: ['switch_type'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'toggle': 1, 'momentary': 2};
            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));
            await entity.write('aqaraOpple', {0x000A: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {switch_type: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x000A], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_switch_power_outage_memory: {
        key: ['power_outage_memory'],
        convertSet: async (entity, key, value, meta) => {
            if (['ZNCZ04LM', 'ZNCZ15LM', 'QBCZ14LM', 'QBCZ15LM', 'SSM-U01', 'SSM-U02', 'DLKZMK11LM', 'DLKZMK12LM',
                'WS-EUK01', 'WS-EUK02', 'WS-EUK03', 'WS-EUK04', 'QBKG19LM', 'QBKG20LM', 'QBKG25LM', 'QBKG26LM',
                'QBKG31LM', 'QBKG34LM', 'QBKG38LM', 'QBKG39LM', 'QBKG40LM', 'QBKG41LM', 'ZNDDMK11LM'].includes(meta.mapped.model)) {
                await entity.write('aqaraOpple', {0x0201: {value: value ? 1 : 0, type: 0x10}}, manufacturerOptions.xiaomi);
            } else if (['ZNCZ02LM', 'QBCZ11LM'].includes(meta.mapped.model)) {
                const payload = value ?
                    [[0xaa, 0x80, 0x05, 0xd1, 0x47, 0x07, 0x01, 0x10, 0x01], [0xaa, 0x80, 0x03, 0xd3, 0x07, 0x08, 0x01]] :
                    [[0xaa, 0x80, 0x05, 0xd1, 0x47, 0x09, 0x01, 0x10, 0x00], [0xaa, 0x80, 0x03, 0xd3, 0x07, 0x0a, 0x01]];

                await entity.write('genBasic', {0xFFF0: {value: payload[0], type: 0x41}}, manufacturerOptions.xiaomi);
                await entity.write('genBasic', {0xFFF0: {value: payload[1], type: 0x41}}, manufacturerOptions.xiaomi);
            } else if (['ZNCZ11LM'].includes(meta.mapped.model)) {
                const payload = value ?
                    [0xaa, 0x80, 0x05, 0xd1, 0x47, 0x00, 0x01, 0x10, 0x01] :
                    [0xaa, 0x80, 0x05, 0xd1, 0x47, 0x01, 0x01, 0x10, 0x00];

                await entity.write('genBasic', {0xFFF0: {value: payload, type: 0x41}}, manufacturerOptions.xiaomi);
            } else {
                throw new Error('Not supported');
            }
            return {state: {power_outage_memory: value}};
        },
        convertGet: async (entity, key, meta) => {
            if (['ZNCZ04LM', 'ZNCZ15LM', 'QBCZ14LM', 'QBCZ15LM', 'SSM-U01', 'SSM-U02', 'DLKZMK11LM', 'DLKZMK12LM',
                'WS-EUK01', 'WS-EUK02', 'WS-EUK03', 'WS-EUK04', 'QBKG19LM', 'QBKG20LM', 'QBKG25LM', 'QBKG26LM',
                'QBKG31LM', 'QBKG34LM', 'QBKG38LM', 'QBKG39LM', 'QBKG40LM', 'QBKG41LM', 'ZNDDMK11LM'].includes(meta.mapped.model)) {
                await entity.read('aqaraOpple', [0x0201]);
            } else if (['ZNCZ02LM', 'QBCZ11LM', 'ZNCZ11LM'].includes(meta.mapped.model)) {
                await entity.read('aqaraOpple', [0xFFF0]);
            } else {
                throw new Error('Not supported');
            }
        },
    },
    xiaomi_light_power_outage_memory: {
        key: ['power_outage_memory'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('genBasic', {0xFF19: {value: value ? 1 : 0, type: 0x10}}, manufacturerOptions.xiaomi);
            return {state: {power_outage_memory: value}};
        },
    },
    xiaomi_power: {
        key: ['power'],
        convertGet: async (entity, key, meta) => {
            const endpoint = meta.device.endpoints.find((e) => e.supportsInputCluster('genAnalogInput'));
            await endpoint.read('genAnalogInput', ['presentValue']);
        },
    },
    xiaomi_auto_off: {
        key: ['auto_off'],
        convertSet: async (entity, key, value, meta) => {
            if (['ZNCZ04LM'].includes(meta.mapped.model)) {
                await entity.write('aqaraOpple', {0x0202: {value: value ? 1 : 0, type: 0x10}}, manufacturerOptions.xiaomi);
            } else if (['ZNCZ11LM'].includes(meta.mapped.model)) {
                const payload = value ?
                    [0xaa, 0x80, 0x05, 0xd1, 0x47, 0x00, 0x02, 0x10, 0x01] :
                    [0xaa, 0x80, 0x05, 0xd1, 0x47, 0x01, 0x02, 0x10, 0x00];

                await entity.write('genBasic', {0xFFF0: {value: payload, type: 0x41}}, manufacturerOptions.xiaomi);
            } else {
                throw new Error('Not supported');
            }
            return {state: {auto_off: value}};
        },
    },
    GZCGQ11LM_detection_period: {
        key: ['detection_period'],
        convertSet: async (entity, key, value, meta) => {
            value *= 1;
            await entity.write('aqaraOpple', {0x0000: {value: [value], type: 0x21}}, manufacturerOptions.xiaomi);
            return {state: {detection_period: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0000], manufacturerOptions.xiaomi);
        },
    },
    aqara_detection_interval: {
        key: ['detection_interval'],
        convertSet: async (entity, key, value, meta) => {
            value *= 1;
            await entity.write('aqaraOpple', {0x0102: {value: [value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {detection_interval: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0102], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_overload_protection: {
        key: ['overload_protection'],
        convertSet: async (entity, key, value, meta) => {
            value *= 1;
            await entity.write('aqaraOpple', {0x020b: {value: [value], type: 0x39}}, manufacturerOptions.xiaomi);
            return {state: {overload_protection: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x020b], manufacturerOptions.xiaomi);
        },
    },
    aqara_switch_mode_switch: {
        key: ['mode_switch'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'anti_flicker_mode': 4, 'quick_mode': 1};
            await entity.write('aqaraOpple', {0x0004: {value: lookup[value], type: 0x21}}, manufacturerOptions.xiaomi);
            return {state: {mode_switch: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0004], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_button_switch_mode: {
        key: ['button_switch_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'relay': 0, 'relay_and_usb': 1};
            await entity.write('aqaraOpple', {0x0226: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {button_switch_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0226], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_socket_button_lock: {
        key: ['button_lock'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'ON': 0, 'OFF': 1};
            await entity.write('aqaraOpple', {0x0200: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {button_lock: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0200], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_led_disabled_night: {
        key: ['led_disabled_night'],
        convertSet: async (entity, key, value, meta) => {
            if (['ZNCZ04LM', 'ZNCZ15LM', 'QBCZ14LM', 'QBCZ15LM', 'QBKG19LM', 'QBKG20LM', 'QBKG25LM', 'QBKG26LM',
                'QBKG31LM', 'QBKG34LM', 'DLKZMK11LM'].includes(meta.mapped.model)) {
                await entity.write('aqaraOpple', {0x0203: {value: value ? 1 : 0, type: 0x10}}, manufacturerOptions.xiaomi);
            } else if (['ZNCZ11LM'].includes(meta.mapped.model)) {
                const payload = value ?
                    [0xaa, 0x80, 0x05, 0xd1, 0x47, 0x00, 0x03, 0x10, 0x00] :
                    [0xaa, 0x80, 0x05, 0xd1, 0x47, 0x01, 0x03, 0x10, 0x01];

                await entity.write('genBasic', {0xFFF0: {value: payload, type: 0x41}}, manufacturerOptions.xiaomi);
            } else {
                throw new Error('Not supported');
            }
            return {state: {led_disabled_night: value}};
        },
        convertGet: async (entity, key, meta) => {
            if (['ZNCZ04LM', 'ZNCZ15LM', 'QBCZ15LM', 'QBCZ14LM', 'QBKG19LM', 'QBKG20LM', 'QBKG25LM', 'QBKG26LM',
                'QBKG31LM', 'QBKG34LM', 'DLKZMK11LM'].includes(meta.mapped.model)) {
                await entity.read('aqaraOpple', [0x0203], manufacturerOptions.xiaomi);
            } else {
                throw new Error('Not supported');
            }
        },
    },
    xiaomi_flip_indicator_light: {
        key: ['flip_indicator_light'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'OFF': 0, 'ON': 1};
            await entity.write('aqaraOpple', {0x00F0: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {flip_indicator_light: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x00F0], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_dimmer_mode: {
        key: ['dimmer_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'rgbw': 3, 'dual_ct': 1};
            value = value.toLowerCase();
            if (['rgbw'].includes(value)) {
                await entity.write('aqaraOpple', {0x0509: {value: lookup[value], type: 0x23}}, manufacturerOptions.xiaomi);
                await entity.write('aqaraOpple', {0x050F: {value: 1, type: 0x23}}, manufacturerOptions.xiaomi);
            } else {
                await entity.write('aqaraOpple', {0x0509: {value: lookup[value], type: 0x23}}, manufacturerOptions.xiaomi);
                // Turn on dimming channel 1 and channel 2
                await entity.write('aqaraOpple', {0x050F: {value: 3, type: 0x23}}, manufacturerOptions.xiaomi);
            }
            return {state: {dimmer_mode: value}};
        },
        convertGet: async (entity, key, value, meta) => {
            await entity.read('aqaraOpple', [0x0509], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_switch_operation_mode_basic: {
        key: ['operation_mode'],
        convertSet: async (entity, key, value, meta) => {
            let targetValue = value.hasOwnProperty('state') ? value.state : value;

            // 1/2 gang switches using genBasic on endpoint 1.
            let attrId;
            let attrValue;
            if (meta.mapped.meta && meta.mapped.meta.multiEndpoint) {
                attrId = {left: 0xFF22, right: 0xFF23}[meta.endpoint_name];
                // Allow usage of control_relay for 2 gang switches by mapping it to the default side.
                if (targetValue === 'control_relay') {
                    targetValue = `control_${meta.endpoint_name}_relay`;
                }
                attrValue = {control_left_relay: 0x12, control_right_relay: 0x22, decoupled: 0xFE}[targetValue];

                if (attrId == null) {
                    throw new Error(`Unsupported endpoint ${meta.endpoint_name} for changing operation_mode.`);
                }
            } else {
                attrId = 0xFF22;
                attrValue = {control_relay: 0x12, decoupled: 0xFE}[targetValue];
            }

            if (attrValue == null) {
                throw new Error('Invalid operation_mode value');
            }

            const endpoint = entity.getDevice().getEndpoint(1);
            const payload = {};
            payload[attrId] = {value: attrValue, type: 0x20};
            await endpoint.write('genBasic', payload, manufacturerOptions.xiaomi);

            return {state: {operation_mode: targetValue}};
        },
        convertGet: async (entity, key, meta) => {
            let attrId;
            if (meta.mapped.meta && meta.mapped.meta.multiEndpoint) {
                attrId = {left: 0xFF22, right: 0xFF23}[meta.endpoint_name];
                if (attrId == null) {
                    throw new Error(`Unsupported endpoint ${meta.endpoint_name} for getting operation_mode.`);
                }
            } else {
                attrId = 0xFF22;
            }
            await entity.read('genBasic', [attrId], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_switch_operation_mode_opple: {
        key: ['operation_mode'],
        convertSet: async (entity, key, value, meta) => {
            // Support existing syntax of a nested object just for the state field. Though it's quite silly IMO.
            const targetValue = value.hasOwnProperty('state') ? value.state : value;
            // Switches using aqaraOpple 0x0200 on the same endpoints as the onOff clusters.
            const lookupState = {control_relay: 0x01, decoupled: 0x00};
            await entity.write('aqaraOpple', {0x0200: {value: lookupState[targetValue], type: 0x20}}, manufacturerOptions.xiaomi);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0200], manufacturerOptions.xiaomi);
        },
    },
    xiaomi_switch_do_not_disturb: {
        key: ['do_not_disturb'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('aqaraOpple', {0x0203: {value: value ? 1 : 0, type: 0x10}}, manufacturerOptions.xiaomi);
            return {state: {do_not_disturb: value}};
        },
    },
    STS_PRS_251_beep: {
        key: ['beep'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command('genIdentify', 'identify', {identifytime: value}, utils.getOptions(meta.mapped, entity));
        },
    },
    xiaomi_curtain_options: {
        key: ['options'],
        convertSet: async (entity, key, value, meta) => {
            const opts = {
                reverse_direction: false,
                hand_open: true,
                reset_limits: false,
                ...value,
            };

            // Legacy names
            if (value.hasOwnProperty('auto_close')) opts.hand_open = value.auto_close;
            if (value.hasOwnProperty('reset_move')) opts.reset_limits = value.reset_move;

            if (meta.mapped.model === 'ZNCLDJ12LM') {
                await entity.write('genBasic', {0xff28: {value: opts.reverse_direction, type: 0x10}}, manufacturerOptions.xiaomi);
                await entity.write('genBasic', {0xff29: {value: !opts.hand_open, type: 0x10}}, manufacturerOptions.xiaomi);

                if (opts.reset_limits) {
                    await entity.write('genBasic', {0xff27: {value: 0x00, type: 0x10}}, manufacturerOptions.xiaomi);
                }
            } else if (meta.mapped.model === 'ZNCLDJ11LM') {
                const payload = [
                    0x07, 0x00, opts.reset_limits ? 0x01 : 0x02, 0x00, opts.reverse_direction ? 0x01 : 0x00, 0x04,
                    !opts.hand_open ? 0x01 : 0x00, 0x12,
                ];

                await entity.write('genBasic', {0x0401: {value: payload, type: 0x42}}, manufacturerOptions.xiaomi);

                // hand_open requires a separate request with slightly different payload
                payload[2] = 0x08;
                await entity.write('genBasic', {0x0401: {value: payload, type: 0x42}}, manufacturerOptions.xiaomi);
            } else {
                throw new Error(`xiaomi_curtain_options set called for not supported model: ${meta.mapped.model}`);
            }

            // Reset limits is an action, not a state.
            delete opts.reset_limits;
            return {state: {options: opts}};
        },
        convertGet: async (entity, key, meta) => {
            if (meta.mapped.model === 'ZNCLDJ11LM') {
                await entity.read('genBasic', [0x0401], manufacturerOptions.xiaomi);
            } else {
                throw new Error(`xiaomi_curtain_options get called for not supported model: ${meta.mapped.model}`);
            }
        },
    },
    xiaomi_curtain_position_state: {
        key: ['state', 'position'],
        options: [exposes.options.invert_cover()],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'state' && typeof value === 'string' && value.toLowerCase() === 'stop') {
                if (meta.mapped.model == 'ZNJLBL01LM') {
                    const payload = {'presentValue': 2};
                    await entity.write('genMultistateOutput', payload);
                } else {
                    await entity.command('closuresWindowCovering', 'stop', {}, utils.getOptions(meta.mapped, entity));
                }

                // Xiaomi curtain does not send position update on stop, request this.
                await entity.read('genAnalogOutput', [0x0055]);
            } else {
                const lookup = {'open': 100, 'close': 0, 'on': 100, 'off': 0};

                value = typeof value === 'string' ? value.toLowerCase() : value;
                value = lookup.hasOwnProperty(value) ? lookup[value] : value;

                if (key === 'position') {
                    value = meta.options.invert_cover ? 100 - value : value;
                }

                const payload = {0x0055: {value, type: 0x39}};
                await entity.write('genAnalogOutput', payload);
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genAnalogOutput', [0x0055]);
        },
    },
    ledvance_commands: {
        /* deprectated osram_*/
        key: ['set_transition', 'remember_state', 'osram_set_transition', 'osram_remember_state'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'osram_set_transition' || key === 'set_transition') {
                if (value) {
                    const transition = (value > 1) ? (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 10 : 1;
                    const payload = {0x0012: {value: transition, type: 0x21}, 0x0013: {value: transition, type: 0x21}};
                    await entity.write('genLevelCtrl', payload);
                }
            } else if (key == 'osram_remember_state' || key == 'remember_state') {
                if (value === true) {
                    await entity.command('manuSpecificOsram', 'saveStartupParams', {}, manufacturerOptions.osram);
                } else if (value === false) {
                    await entity.command('manuSpecificOsram', 'resetStartupParams', {}, manufacturerOptions.osram);
                }
            }
        },
    },
    lidl_watering_timer: {
        key: ['timer'],
        convertSet: (entity, key, value, meta) => {
            tuya.sendDataPointRaw(entity, tuya.dataPoints.lidlTimer, tuya.convertDecimalValueTo4ByteHexArray(value));
        },
    },
    matsee_garage_door_opener: {
        key: ['trigger'],
        convertSet: (entity, key, value, meta) => {
            tuya.sendDataPointBool(entity, tuya.dataPoints.garageDoorTrigger, true);
        },
    },
    SPZ01_power_outage_memory: {
        key: ['power_outage_memory'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('genOnOff', {0x2000: {value: value ? 0x01 : 0x00, type: 0x20}});
            return {state: {power_outage_memory: value}};
        },
    },
    tuya_switch_power_outage_memory: {
        key: ['power_outage_memory'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'off': 0x00, 'on': 0x01, 'restore': 0x02};
            utils.validateValue(value, Object.keys(lookup));
            const payload = lookup[value];
            await entity.write('genOnOff', {0x8002: {value: payload, type: 0x30}});
            return {state: {power_outage_memory: value}};
        },
    },
    kmpcil_res005_on_off: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            const options = {disableDefaultResponse: true};
            utils.validateValue(value, ['toggle', 'off', 'on']);
            if (value.toLowerCase() === 'toggle') {
                if (!meta.state.hasOwnProperty('state')) {
                    throw new Error('Cannot toggle, state not known yet');
                } else {
                    const payload = {0x0055: {value: (meta.state.state === 'OFF') ? 0x01 : 0x00, type: 0x10}};
                    await entity.write('genBinaryOutput', payload, options);
                    return {state: {state: meta.state.state === 'OFF' ? 'ON' : 'OFF'}};
                }
            } else {
                const payload = {0x0055: {value: (value.toUpperCase() === 'OFF') ? 0x00 : 0x01, type: 0x10}};
                await entity.write('genBinaryOutput', payload, options);
                return {state: {state: value.toUpperCase()}};
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genBinaryOutput', ['presentValue']);
        },
    },
    light_onoff_restorable_brightness: {
        /**
         * Some devices reset brightness to 100% when turned on, even if previous brightness was different
         * This uses the stored state of the device to restore to the previous brightness level when turning on
         */
        key: ['state', 'brightness', 'brightness_percent'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            const deviceState = meta.state || {};
            const message = meta.message;
            const state = message.hasOwnProperty('state') ? message.state.toLowerCase() : null;
            const hasBrightness = message.hasOwnProperty('brightness') || message.hasOwnProperty('brightness_percent');

            // Add brightness if command is 'on' and we can restore previous value
            if (state === 'on' && !hasBrightness && deviceState.brightness > 0) {
                message.brightness = deviceState.brightness;
            }

            return await converters.light_onoff_brightness.convertSet(entity, key, value, meta);
        },
        convertGet: async (entity, key, meta) => {
            return await converters.light_onoff_brightness.convertGet(entity, key, meta);
        },
    },
    JTQJBF01LMBW_JTYJGD01LMBW_sensitivity: {
        key: ['sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'low': 0x04010000, 'medium': 0x04020000, 'high': 0x04030000};
            utils.validateValue(value, Object.keys(lookup));

            // Timeout of 30 seconds + required (https://github.com/Koenkk/zigbee2mqtt/issues/2287)
            const options = {...manufacturerOptions.xiaomi, timeout: 35000};
            await entity.write('ssIasZone', {0xFFF1: {value: lookup[value], type: 0x23}}, options);
            return {state: {sensitivity: value}};
        },
    },
    JTQJBF01LMBW_JTYJGD01LMBW_selfest: {
        key: ['selftest'],
        convertSet: async (entity, key, value, meta) => {
            // Timeout of 30 seconds + required (https://github.com/Koenkk/zigbee2mqtt/issues/2287)
            const options = {...manufacturerOptions.xiaomi, timeout: 35000};
            await entity.write('ssIasZone', {0xFFF1: {value: 0x03010000, type: 0x23}}, options);
        },
    },
    JTBZ01AQA_gas: {
        key: ['gas'],
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x013a], manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_gas_density: {
        key: ['gas_density'],
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x013b], manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_gas_sensitivity: {
        key: ['gas_sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'15%lel': 1, '10%lel': 2};
            await entity.write('aqaraOpple', {0x010c: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {gas_sensitivity: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x010c], manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_selftest: {
        key: ['selftest'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('aqaraOpple', {0x0127: {value: true, type: 0x10}}, manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_mute_buzzer: {
        key: ['mute_buzzer'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('aqaraOpple', {0x013f: {value: 15360, type: 0x23}}, manufacturerOptions.xiaomi);
            await entity.write('aqaraOpple', {0x0126: {value: 1, type: 0x20}}, manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_mute: {
        key: ['mute'],
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0126], manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_linkage_alarm: {
        key: ['linkage_alarm'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {true: 1, false: 0};
            await entity.write('aqaraOpple', {0x014b: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {linkage_alarm: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x014b], manufacturerOptions.xiaomi);
        },
    },
    JTBZ01AQA_state: {
        key: ['state'],
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0139], manufacturerOptions.xiaomi);
        },
    },
    aqara_power_outage_count: {
        key: ['power_outage_count'],
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x0002], manufacturerOptions.xiaomi);
        },
    },
    LLKZMK11LM_interlock: {
        key: ['interlock'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('genBinaryOutput', {0xff06: {value: value ? 0x01 : 0x00, type: 0x10}}, manufacturerOptions.xiaomi);
            return {state: {interlock: value}};
        },
    },
    DJT11LM_vibration_sensitivity: {
        key: ['sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'low': 0x15, 'medium': 0x0B, 'high': 0x01};
            utils.validateValue(value, Object.keys(lookup));

            const options = {...manufacturerOptions.xiaomi, timeout: 35000};
            await entity.write('genBasic', {0xFF0D: {value: lookup[value], type: 0x20}}, options);
            return {state: {sensitivity: value}};
        },
    },
    hue_wall_switch_device_mode: {
        key: ['device_mode'],
        convertSet: async (entity, key, value, meta) => {
            const values = ['single_rocker', 'single_push_button', 'dual_rocker', 'dual_push_button'];
            utils.validateValue(value, values);
            await entity.write('genBasic', {0x0034: {value: values.indexOf(value), type: 48}}, manufacturerOptions.hue);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genBasic', [0x0034], manufacturerOptions.hue);
        },
    },
    danfoss_thermostat_occupied_heating_setpoint: {
        key: ['occupied_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {
                setpointType: 1,
                setpoint: (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100,
            };
            await entity.command('hvacThermostat', 'danfossSetpointCommand', payload, manufacturerOptions.danfoss);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['occupiedHeatingSetpoint']);
        },
    },
    danfoss_mounted_mode_active: {
        key: ['mounted_mode_active'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossMountedModeActive'], manufacturerOptions.danfoss);
        },
    },
    danfoss_mounted_mode_control: {
        key: ['mounted_mode_control'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossMountedModeControl': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'mounted_mode_control': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossMountedModeControl'], manufacturerOptions.danfoss);
        },
    },
    danfoss_thermostat_vertical_orientation: {
        key: ['thermostat_vertical_orientation'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossThermostatOrientation': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'thermostat_vertical_orientation': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossThermostatOrientation'], manufacturerOptions.danfoss);
        },
    },
    danfoss_external_measured_room_sensor: {
        key: ['external_measured_room_sensor'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossExternalMeasuredRoomSensor': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'external_measured_room_sensor': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossExternalMeasuredRoomSensor'], manufacturerOptions.danfoss);
        },
    },
    danfoss_radiator_covered: {
        key: ['radiator_covered'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossRadiatorCovered': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'radiator_covered': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossRadiatorCovered'], manufacturerOptions.danfoss);
        },
    },
    danfoss_viewing_direction: {
        key: ['viewing_direction'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacUserInterfaceCfg', {'danfossViewingDirection': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'viewing_direction': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacUserInterfaceCfg', ['danfossViewingDirection'], manufacturerOptions.danfoss);
        },
    },
    danfoss_algorithm_scale_factor: {
        key: ['algorithm_scale_factor'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossAlgorithmScaleFactor': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'algorithm_scale_factor': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossAlgorithmScaleFactor'], manufacturerOptions.danfoss);
        },
    },
    danfoss_heat_available: {
        key: ['heat_available'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossHeatAvailable': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'heat_available': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossHeatAvailable'], manufacturerOptions.danfoss);
        },
    },
    danfoss_heat_required: {
        key: ['heat_required'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossHeatRequired'], manufacturerOptions.danfoss);
        },
    },
    danfoss_day_of_week: {
        key: ['day_of_week'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {'danfossDayOfWeek': utils.getKey(constants.dayOfWeek, value, undefined, Number)};
            await entity.write('hvacThermostat', payload, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'day_of_week': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossDayOfWeek'], manufacturerOptions.danfoss);
        },
    },
    danfoss_trigger_time: {
        key: ['trigger_time'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossTriggerTime': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'trigger_time': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossTriggerTime'], manufacturerOptions.danfoss);
        },
    },
    danfoss_window_open_feature: {
        key: ['window_open_feature'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossWindowOpenFeatureEnable': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'window_open_feature': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossWindowOpenFeatureEnable'], manufacturerOptions.danfoss);
        },
    },
    danfoss_window_open_internal: {
        key: ['window_open_internal'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossWindowOpenInternal'], manufacturerOptions.danfoss);
        },
    },
    danfoss_window_open_external: {
        key: ['window_open_external'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossWindowOpenExternal': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'window_open_external': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossWindowOpenExternal'], manufacturerOptions.danfoss);
        },
    },
    danfoss_load_balancing_enable: {
        key: ['load_balancing_enable'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossLoadBalancingEnable': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'load_balancing_enable': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossLoadBalancingEnable'], manufacturerOptions.danfoss);
        },
    },
    danfoss_load_room_mean: {
        key: ['load_room_mean'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('hvacThermostat', {'danfossLoadRoomMean': value}, manufacturerOptions.danfoss);
            return {readAfterWriteTime: 200, state: {'load_room_mean': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossLoadRoomMean'], manufacturerOptions.danfoss);
        },
    },
    danfoss_load_estimate: {
        key: ['load_estimate'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossLoadEstimate'], manufacturerOptions.danfoss);
        },
    },
    danfoss_output_status: {
        key: ['output_status'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossOutputStatus'], manufacturerOptions.danfoss);
        },
    },
    danfoss_room_status_code: {
        key: ['room_status_code'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['danfossRoomStatusCode'], manufacturerOptions.danfoss);
        },
    },
    danfoss_system_status_code: {
        key: ['system_status_code'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haDiagnostic', ['danfossSystemStatusCode'], manufacturerOptions.danfoss);
        },
    },
    danfoss_system_status_water: {
        key: ['system_status_water'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haDiagnostic', ['danfossSystemStatusWater'], manufacturerOptions.danfoss);
        },
    },
    danfoss_multimaster_role: {
        key: ['multimaster_role'],
        convertGet: async (entity, key, meta) => {
            await entity.read('haDiagnostic', ['danfossMultimasterRole'], manufacturerOptions.danfoss);
        },
    },
    develco_pulse_configuration: {
        key: ['pulse_configuration'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('seMetering', {'develcoPulseConfiguration': value}, manufacturerOptions.develco);
            return {readAfterWriteTime: 200, state: {'pulse_configuration': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('seMetering', ['develcoPulseConfiguration'], manufacturerOptions.develco);
        },
    },
    develco_interface_mode: {
        key: ['interface_mode'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {'develcoInterfaceMode': utils.getKey(constants.develcoInterfaceMode, value, undefined, Number)};
            await entity.write('seMetering', payload, manufacturerOptions.develco);
            return {readAfterWriteTime: 200, state: {'interface_mode': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('seMetering', ['develcoInterfaceMode'], manufacturerOptions.develco);
        },
    },
    develco_current_summation: {
        key: ['current_summation'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('seMetering', {'develcoCurrentSummation': value}, manufacturerOptions.develco);
            return {state: {'current_summation': value}};
        },
    },
    ZMCSW032D_cover_position: {
        key: ['position', 'tilt'],
        convertSet: async (entity, key, value, meta) => {
            if (meta.options.hasOwnProperty('time_close') && meta.options.hasOwnProperty('time_open')) {
                const sleepSeconds = async (s) => {
                    return new Promise((resolve) => setTimeout(resolve, s * 1000));
                };

                const oldPosition = meta.state.position;
                if (value == 100) {
                    await entity.command('closuresWindowCovering', 'upOpen', {}, utils.getOptions(meta.mapped));
                } else if (value == 0) {
                    await entity.command('closuresWindowCovering', 'downClose', {}, utils.getOptions(meta.mapped));
                } else {
                    if (oldPosition > value) {
                        const delta = oldPosition - value;
                        const mutiplicateur = meta.options.time_open / 100;
                        const timeBeforeStop = delta * mutiplicateur;
                        await entity.command('closuresWindowCovering', 'downClose', {}, utils.getOptions(meta.mapped));
                        await sleepSeconds(timeBeforeStop);
                        await entity.command('closuresWindowCovering', 'stop', {}, utils.getOptions(meta.mapped));
                    } else if (oldPosition < value) {
                        const delta = value - oldPosition;
                        const mutiplicateur = meta.options.time_close / 100;
                        const timeBeforeStop = delta * mutiplicateur;
                        await entity.command('closuresWindowCovering', 'upOpen', {}, utils.getOptions(meta.mapped));
                        await sleepSeconds(timeBeforeStop);
                        await entity.command('closuresWindowCovering', 'stop', {}, utils.getOptions(meta.mapped));
                    }
                }

                return {state: {position: value}};
            }
        },
        convertGet: async (entity, key, meta) => {
            const isPosition = (key === 'position');
            await entity.read('closuresWindowCovering', [isPosition ? 'currentPositionLiftPercentage' : 'currentPositionTiltPercentage']);
        },
    },
    moes_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.moesChildLock, value === 'LOCK');
        },
    },
    moes_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesHeatingSetpoint, value);
        },
    },
    moes_thermostat_deadzone_temperature: {
        key: ['deadzone_temperature'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesDeadZoneTemp, value);
        },
    },
    moes_thermostat_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            if (value < 0) value = 4096 + value;
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesTempCalibration, value);
        },
    },
    moes_thermostat_max_temperature_limit: {
        key: ['max_temperature_limit'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesMaxTempLimit, value);
        },
    },
    moes_thermostat_mode: {
        key: ['preset'],
        convertSet: async (entity, key, value, meta) => {
            const hold = value === 'hold' ? 0 : 1;
            const schedule = value === 'program' ? 0 : 1;
            await tuya.sendDataPointEnum(entity, tuya.dataPoints.moesHold, hold);
            await tuya.sendDataPointEnum(entity, tuya.dataPoints.moesScheduleEnable, schedule);
        },
    },
    moes_thermostat_standby: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.state, value === 'heat');
        },
    },
    moesS_thermostat_system_mode: {
        key: ['preset'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'programming': 0, 'manual': 1, 'temporary_manual': 2, 'holiday': 3};
            await tuya.sendDataPointEnum(entity, tuya.dataPoints.moesSsystemMode, lookup[value]);
        },
    },
    moesS_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesSheatingSetpoint, temp);
        },
    },
    moesS_thermostat_boost_heating: {
        key: ['boost_heating'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.moesSboostHeating, value === 'ON');
        },
    },
    moesS_thermostat_window_detection: {
        key: ['window_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.moesSwindowDetectionFunktion_A2, value === 'ON');
        },
    },
    moesS_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.moesSchildLock, value === 'LOCK');
        },
    },
    moesS_thermostat_boostHeatingCountdownTimeSet: {
        key: ['boost_heating_countdown_time_set'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesSboostHeatingCountdownTimeSet, value);
        },
    },
    moesS_thermostat_temperature_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            let temp = Math.round(value * 1);
            if (temp < 0) {
                temp = 0xFFFFFFFF + temp + 1;
            }
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesScompensationTempSet, temp);
        },
    },
    moesS_thermostat_moesSecoMode: {
        key: ['eco_mode'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.moesSecoMode, value === 'ON');
        },
    },
    moesS_thermostat_eco_temperature: {
        key: ['eco_temperature'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesSecoModeTempSet, temp);
        },
    },
    moesS_thermostat_max_temperature: {
        key: ['max_temperature'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesSmaxTempSet, temp);
        },
    },
    moesS_thermostat_min_temperature: {
        key: ['min_temperature'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.moesSminTempSet, temp);
        },
    },
    moesS_thermostat_schedule_programming: {
        key: ['programming_mode'],
        convertSet: async (entity, key, value, meta) => {
            const payload = [];
            const items = value.split('  ');
            for (let i = 0; i < 12; i++) {
                const hourTemperature = items[i].split('/');
                const hourMinute = hourTemperature[0].split(':', 2);
                const h = parseInt(hourMinute[0]);
                const m = parseInt(hourMinute[1]);
                const temp = parseInt(hourTemperature[1]);
                if (h < 0 || h >= 24 || m < 0 || m >= 60 || temp < 5 || temp >= 35) {
                    throw new Error('Invalid hour, minute or temperature of:' + items[i]);
                }
                payload[i*3] = h; payload[i*3+1] = m; payload[i*3+2] = temp * 2;
            }
            return tuya.sendDataPointRaw(entity, tuya.dataPoints.moesSschedule, payload);
        },
    },
    tvtwo_thermostat: {
        key: [
            'child_lock', 'open_window', 'open_window_temperature', 'frost_protection', 'heating_stop',
            'current_heating_setpoint', 'local_temperature_calibration', 'preset', 'boost_timeset_countdown',
            'holiday_start_stop', 'holiday_temperature', 'comfort_temperature', 'eco_temperature',
            'working_day', 'week_schedule_programming', 'online', 'holiday_mode_date',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'preset': {
                const presetLookup = {'auto': 0, 'manual': 1, 'holiday': 3};
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, presetLookup[value]);
                return {state: {preset: value}};}
            case 'heating_stop':
                if (value == 'ON') {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 1);
                } else {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 0);
                    await utils.sleep(500);
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, 1 /* manual */);
                }
                break;
            case 'frost_protection':
                if (value == 'ON') {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvFrostDetection, 1);
                } else {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvFrostDetection, 0);
                    await utils.sleep(500);
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, 1 /* manual */);
                }
                break;
            case 'open_window':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.tvWindowDetection, value === 'ON');
                break;
            case 'child_lock':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.tvChildLock, value === 'LOCK');
                break;
            case 'local_temperature_calibration':
                if (value > 0) value = value*10;
                if (value < 0) value = value*10 + 0x100000000;
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvTempCalibration, value);
                break;
            case 'current_heating_setpoint':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvHeatingSetpoint, value * 10);
                await utils.sleep(500);
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, 1 /* manual */);
                break;
            case 'holiday_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvHolidayTemp, value * 10);
                break;
            case 'comfort_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvComfortTemp, value * 10);
                break;
            case 'eco_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvEcoTemp, value * 10);
                break;
            case 'boost_timeset_countdown':
                // set min 0 - max 465 sec boost time
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvBoostTime, value);
                break;
            case 'open_window_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvOpenWindowTemp, value * 10);
                break;
            case 'holiday_start_stop': {
                const numberPattern = /\d+/g;
                value = value.match(numberPattern).join([]).toString();
                return tuya.sendDataPointStringBuffer(entity, tuya.dataPoints.tvHolidayMode, value);
            }
            case 'online':
                // 115 online / Is the device online
                await tuya.sendDataPointBool(entity, tuya.dataPoints.tvBoostMode, value === 'ON');
                break;
            case 'working_day': {
                // DP-31, Send and Report, ENUM,  Week select 0 - 5 days, 1 - 6 days, 2 - 7 days
                const workLookup = {'0': 0, '1': 1, '2': 2, '3': 3};
                const workDay = workLookup[value];
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvWorkingDay, workDay);
                return {state: {working_day: value}};
            }
            case 'week_schedule_programming':
                // DP-106, Send Only, raw, week_program3_day
                await tuya.sendDataPointRaw(entity, tuya.dataPoints.tvWeekSchedule, value);
                break;

            default: // Unknown key
                meta.logger.warn(`toZigbee.tvtwo_thermostat: Unhandled key ${key}`);
            }
        },
    },
    haozee_thermostat_system_mode: {
        key: ['preset'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'auto': 0, 'manual': 1, 'off': 2, 'on': 3};
            await tuya.sendDataPointEnum(entity, tuya.dataPoints.haozeeSystemMode, lookup[value]);
        },
    },
    haozee_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value*10);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.haozeeHeatingSetpoint, temp);
        },
    },
    haozee_thermostat_boost_heating: {
        key: ['boost_heating'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.haozeeBoostHeating, value === 'ON');
        },
    },
    haozee_thermostat_boost_heating_countdown: {
        key: ['boost_heating_countdown'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.haozeeBoostHeatingCountdown, value);
        },
    },
    haozee_thermostat_window_detection: {
        key: ['window_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.haozeeWindowDetection, value === 'ON');
        },
    },
    haozee_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.haozeeChildLock, value === 'LOCK');
        },
    },
    haozee_thermostat_temperature_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            let temp = Math.round(value * 10);
            if (temp < 0) {
                temp = 0xFFFFFFFF + temp + 1;
            }
            await tuya.sendDataPointValue(entity, tuya.dataPoints.haozeeTempCalibration, temp);
        },
    },
    haozee_thermostat_max_temperature: {
        key: ['max_temperature'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value*10);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.haozeeMaxTemp, temp);
        },
    },
    haozee_thermostat_min_temperature: {
        key: ['min_temperature'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value*10);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.haozeeMinTemp, temp);
        },
    },
    hgkg_thermostat_standby: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.state, value === 'cool');
        },
    },
    moes_power_on_behavior: {
        key: ['power_on_behavior'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'off': 0, 'on': 1, 'previous': 2};
            utils.validateValue(value, Object.keys(lookup));
            const pState = lookup[value];
            await entity.write('genOnOff', {moesStartUpOnOff: pState});
            return {state: {power_on_behavior: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['moesStartUpOnOff']);
        },
    },
    moes_switch: {
        key: ['power_on_behavior', 'indicate_light'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'power_on_behavior':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.moesSwitchPowerOnBehavior,
                    utils.getKey(tuya.moesSwitch.powerOnBehavior, value),
                );
                break;
            case 'indicate_light':
                await tuya.sendDataPointValue(
                    entity,
                    tuya.dataPoints.moesSwitchIndicateLight,
                    utils.getKey(tuya.moesSwitch.indicateLight, value),
                );
                break;
            default:
                meta.logger.warn(`toZigbee.moes_switch: Unhandled Key ${key}`);
                break;
            }
        },
    },
    moes_thermostat_sensor: {
        key: ['sensor'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value === 'string') {
                value = value.toLowerCase();
                const lookup = {'in': 0, 'al': 1, 'ou': 2};
                utils.validateValue(value, Object.keys(lookup));
                value = lookup[value];
            }
            if ((typeof value === 'number') && (value >= 0) && (value <= 2)) {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.moesSensor, value);
            } else {
                throw new Error(`Unsupported value: ${value}`);
            }
        },
    },
    easycode_auto_relock: {
        key: ['auto_relock'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('closuresDoorLock', {autoRelockTime: value ? 1 : 0}, utils.getOptions(meta.mapped, entity));
            return {state: {auto_relock: value}};
        },
    },
    tuya_led_control: {
        key: ['brightness', 'color', 'color_temp'],
        options: [exposes.options.color_sync()],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'brightness' && meta.state.color_mode == constants.colorMode[2] &&
                !meta.message.hasOwnProperty('color') && !meta.message.hasOwnProperty('color_temp')) {
                const zclData = {level: Number(value), transtime: 0};

                await entity.command('genLevelCtrl', 'moveToLevel', zclData, utils.getOptions(meta.mapped, entity));

                globalStore.putValue(entity, 'brightness', zclData.level);

                return {state: {brightness: zclData.level}};
            }

            if (key === 'brightness' && meta.message.hasOwnProperty('color_temp')) {
                const zclData = {colortemp: utils.mapNumberRange(meta.message.color_temp, 500, 154, 0, 254), transtime: 0};
                const zclDataBrightness = {level: Number(value), transtime: 0};

                await entity.command('lightingColorCtrl', 'tuyaRgbMode', {enable: 0}, {}, {disableDefaultResponse: true});
                await entity.command('lightingColorCtrl', 'moveToColorTemp', zclData, utils.getOptions(meta.mapped, entity));
                await entity.command('genLevelCtrl', 'moveToLevel', zclDataBrightness, utils.getOptions(meta.mapped, entity));

                globalStore.putValue(entity, 'brightness', zclDataBrightness.level);

                const newState = {
                    brightness: zclDataBrightness.level,
                    color_mode: constants.colorMode[2],
                    color_temp: meta.message.color_temp,
                };

                return {state: libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger),
                    readAfterWriteTime: zclData.transtime * 100};
            }

            if (key === 'color_temp') {
                const zclData = {colortemp: utils.mapNumberRange(value, 500, 154, 0, 254), transtime: 0};
                const zclDataBrightness = {level: globalStore.getValue(entity, 'brightness') || 100, transtime: 0};

                await entity.command('lightingColorCtrl', 'tuyaRgbMode', {enable: 0}, {}, {disableDefaultResponse: true});
                await entity.command('lightingColorCtrl', 'moveToColorTemp', zclData, utils.getOptions(meta.mapped, entity));
                await entity.command('genLevelCtrl', 'moveToLevel', zclDataBrightness, utils.getOptions(meta.mapped, entity));

                const newState = {
                    brightness: zclDataBrightness.level,
                    color_mode: constants.colorMode[2],
                    color_temp: value,
                };

                return {state: libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger),
                    readAfterWriteTime: zclData.transtime * 100};
            }

            const zclData = {
                brightness: globalStore.getValue(entity, 'brightness') || 100,
                hue: utils.mapNumberRange(meta.state.color.h, 0, 360, 0, 254) || 100,
                saturation: utils.mapNumberRange(meta.state.color.s, 0, 100, 0, 254) || 100,
                transtime: 0,
            };

            if (value.h) {
                zclData.hue = utils.mapNumberRange(value.h, 0, 360, 0, 254);
            }
            if (value.hue) {
                zclData.hue = utils.mapNumberRange(value.hue, 0, 360, 0, 254);
            }
            if (value.s) {
                zclData.saturation = utils.mapNumberRange(value.s, 0, 100, 0, 254);
            }
            if (value.saturation) {
                zclData.saturation = utils.mapNumberRange(value.saturation, 0, 100, 0, 254);
            }
            if (value.b) {
                zclData.brightness = Number(value.b);
            }
            if (value.brightness) {
                zclData.brightness = Number(value.brightness);
            }
            if (typeof value === 'number') {
                zclData.brightness = value;
            }

            if (meta.message.hasOwnProperty('color')) {
                if (meta.message.color.h) {
                    zclData.hue = utils.mapNumberRange(meta.message.color.h, 0, 360, 0, 254);
                }
                if (meta.message.color.s) {
                    zclData.saturation = utils.mapNumberRange(meta.message.color.s, 0, 100, 0, 254);
                }
                if (meta.message.color.b) {
                    zclData.brightness = Number(meta.message.color.b);
                }
                if (meta.message.color.brightness) {
                    zclData.brightness = Number(meta.message.color.brightness);
                }
            }

            await entity.command('lightingColorCtrl', 'tuyaRgbMode', {enable: 1}, {}, {disableDefaultResponse: true});
            await entity.command('lightingColorCtrl', 'tuyaMoveToHueAndSaturationBrightness',
                zclData, utils.getOptions(meta.mapped, entity));

            globalStore.putValue(entity, 'brightness', zclData.brightness);

            const newState = {
                brightness: zclData.brightness,
                color: {
                    h: utils.mapNumberRange(zclData.hue, 0, 254, 0, 360),
                    hue: utils.mapNumberRange(zclData.hue, 0, 254, 0, 360),
                    s: utils.mapNumberRange(zclData.saturation, 0, 254, 0, 100),
                    saturation: utils.mapNumberRange(zclData.saturation, 0, 254, 0, 100),
                },
                color_mode: constants.colorMode[0],
            };

            return {state: libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger),
                readAfterWriteTime: zclData.transtime * 100};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', [
                'currentHue', 'currentSaturation', 'tuyaBrightness', 'tuyaRgbMode', 'colorTemperature',
            ]);
        },
    },
    tuya_led_controller: {
        key: ['state', 'color'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'state') {
                if (value.toLowerCase() === 'off') {
                    await entity.command(
                        'genOnOff', 'offWithEffect', {effectid: 0x01, effectvariant: 0x01}, utils.getOptions(meta.mapped, entity),
                    );
                } else {
                    const payload = {level: 255, transtime: 0};
                    await entity.command('genLevelCtrl', 'moveToLevelWithOnOff', payload, utils.getOptions(meta.mapped, entity));
                }
                return {state: {state: value.toUpperCase()}};
            } else if (key === 'color') {
                const hue = {};
                const saturation = {};

                hue.hue = utils.mapNumberRange(value.h, 0, 360, 0, 254);
                saturation.saturation = utils.mapNumberRange(value.s, 0, 100, 0, 254);

                hue.transtime = saturation.transtime = 0;
                hue.direction = 0;

                await entity.command('lightingColorCtrl', 'moveToHue', hue, {}, utils.getOptions(meta.mapped, entity));
                await entity.command('lightingColorCtrl', 'moveToSaturation', saturation, {}, utils.getOptions(meta.mapped, entity));
            }
        },
        convertGet: async (entity, key, meta) => {
            if (key === 'state') {
                await entity.read('genOnOff', ['onOff']);
            } else if (key === 'color') {
                await entity.read('lightingColorCtrl', ['currentHue', 'currentSaturation']);
            }
        },
    },
    tuya_dimmer_state: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            // Always use same transid as tuya_dimmer_level (https://github.com/Koenkk/zigbee2mqtt/issues/6366)
            await tuya.sendDataPointBool(entity, tuya.dataPoints.state, value === 'ON', 'dataRequest', 1);
        },
    },
    tuya_dimmer_level: {
        key: ['brightness_min', 'brightness', 'brightness_percent', 'level'],
        convertSet: async (entity, key, value, meta) => {
            // upscale to 1000
            let newValue;
            let dp = tuya.dataPoints.dimmerLevel;
            if (meta.device.manufacturerName === '_TZE200_9i9dt8is' || meta.device.manufacturerName === '_TZE200_dfxkcots') {
                dp = tuya.dataPoints.eardaDimmerLevel;
            }
            if (key === 'brightness_min') {
                if (value >= 0 && value <= 100) {
                    newValue = utils.mapNumberRange(value, 0, 100, 0, 1000);
                    dp = tuya.dataPoints.dimmerLevel;
                } else {
                    throw new Error('Dimmer brightness_min is out of range 0..100');
                }
            } else if (key === 'level') {
                if (value >= 0 && value <= 1000) {
                    newValue = Math.round(Number(value));
                } else {
                    throw new Error('Dimmer level is out of range 0..1000');
                }
            } else if (key === 'brightness_percent') {
                if (value >= 0 && value <= 100) {
                    newValue = utils.mapNumberRange(value, 0, 100, 0, 1000);
                } else {
                    throw new Error('Dimmer brightness_percent is out of range 0..100');
                }
            } else {
                if (value >= 0 && value <= 255) {
                    newValue = utils.mapNumberRange(value, 0, 255, 0, 1000);
                } else {
                    throw new Error('Dimmer brightness is out of range 0..255');
                }
            }
            // Always use same transid as tuya_dimmer_state (https://github.com/Koenkk/zigbee2mqtt/issues/6366)
            await tuya.sendDataPointValue(entity, dp, newValue, 'dataRequest', 1);
        },
    },
    tuya_switch_state: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {l1: 1, l2: 2, l3: 3, l4: 4};
            const multiEndpoint = utils.getMetaValue(entity, meta.mapped, 'multiEndpoint', 'allEqual', false);
            const keyid = multiEndpoint ? lookup[meta.endpoint_name] : 1;
            await tuya.sendDataPointBool(entity, keyid, value === 'ON');
            return {state: {state: value.toUpperCase()}};
        },
    },
    tuya_switch_type: {
        key: ['switch_type'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            const lookup = {'toggle': 0, 'state': 1, 'momentary': 2};
            utils.validateValue(value, Object.keys(lookup));
            await entity.write('manuSpecificTuya_3', {'switchType': lookup[value]}, {disableDefaultResponse: true});
            return {state: {switch_type: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('manuSpecificTuya_3', ['switchType']);
        },
    },
    tuya_min_brightness: {
        key: ['min_brightness'],
        convertSet: async (entity, key, value, meta) => {
            const minValueHex = value.toString(16);
            const maxValueHex = 'ff';
            const minMaxValue = parseInt(`${minValueHex}${maxValueHex}`, 16);
            const payload = {0xfc00: {value: minMaxValue, type: 0x21}};
            await entity.write('genLevelCtrl', payload, {disableDefaultResponse: true});
            return {state: {min_brightness: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genLevelCtrl', [0xfc00]);
        },
    },
    frankever_threshold: {
        key: ['threshold'],
        convertSet: async (entity, key, value, meta) => {
            // input to multiple of 10 with max value of 100
            const thresh = Math.abs(Math.min(10 * (Math.floor(value / 10)), 100));
            await tuya.sendDataPointValue(entity, tuya.dataPoints.frankEverTreshold, thresh, 'dataRequest', 1);
            return {state: {threshold: value}};
        },
    },
    frankever_timer: {
        key: ['timer'],
        convertSet: async (entity, key, value, meta) => {
            // input in minutes with maximum of 600 minutes (equals 10 hours)
            const timer = 60 * Math.abs(Math.min(value, 600));
            // sendTuyaDataPoint* functions take care of converting the data to proper format
            await tuya.sendDataPointValue(entity, tuya.dataPoints.frankEverTimer, timer, 'dataRequest', 1);
            return {state: {timer: value}};
        },
    },
    RM01_light_onoff_brightness: {
        key: ['state', 'brightness', 'brightness_percent'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (utils.hasEndpoints(meta.device, [0x12])) {
                const endpoint = meta.device.getEndpoint(0x12);
                return await converters.light_onoff_brightness.convertSet(endpoint, key, value, meta);
            } else {
                throw new Error('OnOff and LevelControl not supported on this RM01 device.');
            }
        },
        convertGet: async (entity, key, meta) => {
            if (utils.hasEndpoints(meta.device, [0x12])) {
                const endpoint = meta.device.getEndpoint(0x12);
                return await converters.light_onoff_brightness.convertGet(endpoint, key, meta);
            } else {
                throw new Error('OnOff and LevelControl not supported on this RM01 device.');
            }
        },
    },
    RM01_light_brightness_step: {
        options: [exposes.options.transition()],
        key: ['brightness_step', 'brightness_step_onoff'],
        convertSet: async (entity, key, value, meta) => {
            if (utils.hasEndpoints(meta.device, [0x12])) {
                const endpoint = meta.device.getEndpoint(0x12);
                return await converters.light_brightness_step.convertSet(endpoint, key, value, meta);
            } else {
                throw new Error('LevelControl not supported on this RM01 device.');
            }
        },
    },
    RM01_light_brightness_move: {
        key: ['brightness_move', 'brightness_move_onoff'],
        convertSet: async (entity, key, value, meta) => {
            if (utils.hasEndpoints(meta.device, [0x12])) {
                const endpoint = meta.device.getEndpoint(0x12);
                return await converters.light_brightness_move.convertSet(endpoint, key, value, meta);
            } else {
                throw new Error('LevelControl not supported on this RM01 device.');
            }
        },
    },
    aqara_opple_operation_mode: {
        key: ['operation_mode'],
        convertSet: async (entity, key, value, meta) => {
            // modes:
            // 0 - 'command' mode. keys send commands. useful for binding
            // 1 - 'event' mode. keys send events. useful for handling
            const lookup = {command: 0, event: 1};
            const endpoint = meta.device.getEndpoint(1);
            await endpoint.write('aqaraOpple', {'mode': lookup[value.toLowerCase()]}, {manufacturerCode: 0x115f});
            return {state: {operation_mode: value.toLowerCase()}};
        },
        convertGet: async (entity, key, meta) => {
            const endpoint = meta.device.getEndpoint(1);
            await endpoint.read('aqaraOpple', ['mode'], {manufacturerCode: 0x115f});
        },
    },
    ZVG1_timer: {
        key: ['timer'],
        convertSet: async (entity, key, value, meta) => {
            // input in minutes with maximum of 600 minutes (equals 10 hours)
            const timer = 60 * Math.abs(Math.min(value, 600));
            // sendTuyaDataPoint* functions take care of converting the data to proper format
            await tuya.sendDataPointValue(entity, 11, timer, 'dataRequest', 1);
            return {state: {timer: value}};
        },
    },
    ZVG1_timer_state: {
        key: ['timer_state'],
        convertSet: async (entity, key, value, meta) => {
            let timerState = 2;
            if (value === 'disabled') timerState = 0;
            else if (value === 'active') timerState = 1;
            await tuya.sendDataPointValue(entity, 11, timerState, 'dataRequest', 1);
            return {state: {timer_state: value}};
        },
    },
    EMIZB_132_mode: {
        key: ['interface_mode'],
        convertSet: async (entity, key, value, meta) => {
            const endpoint = meta.device.getEndpoint(2);
            const lookup = {
                'norwegian_han': {value: 0x0200, acVoltageDivisor: 10, acCurrentDivisor: 10},
                'norwegian_han_extra_load': {value: 0x0201, acVoltageDivisor: 10, acCurrentDivisor: 10},
                'aidon_meter': {value: 0x0202, acVoltageDivisor: 10, acCurrentDivisor: 10},
                'kaifa_and_kamstrup': {value: 0x0203, acVoltageDivisor: 10, acCurrentDivisor: 1000},
            };

            if (!lookup[value]) {
                throw new Error(`Interface mode '${value}' is not valid, chose: ${Object.keys(lookup)}`);
            }

            await endpoint.write(
                'seMetering', {0x0302: {value: lookup[value].value, type: 49}}, {manufacturerCode: 0x1015},
            );

            // As the device reports the incorrect divisor, we need to set it here
            // https://github.com/Koenkk/zigbee-herdsman-converters/issues/974#issuecomment-604347303
            // Values for norwegian_han and aidon_meter have not been been checked
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {
                acVoltageMultiplier: 1,
                acVoltageDivisor: lookup[value].acVoltageDivisor,
                acCurrentMultiplier: 1,
                acCurrentDivisor: lookup[value].acCurrentDivisor,
            });

            return {state: {interface_mode: value}};
        },
    },
    eurotronic_thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            const systemMode = utils.getKey(legacy.thermostatSystemModes, value, value, Number);
            const hostFlags = {};
            switch (systemMode) {
            case 0: // off (window_open for eurotronic)
                hostFlags['boost'] = false;
                hostFlags['window_open'] = true;
                break;
            case 4: // heat (boost for eurotronic)
                hostFlags['boost'] = true;
                hostFlags['window_open'] = false;
                break;
            default:
                hostFlags['boost'] = false;
                hostFlags['window_open'] = false;
                break;
            }
            await converters.eurotronic_host_flags.convertSet(entity, 'eurotronic_host_flags', hostFlags, meta);
        },
        convertGet: async (entity, key, meta) => {
            await converters.eurotronic_host_flags.convertGet(entity, 'eurotronic_host_flags', meta);
        },
    },
    eurotronic_host_flags: {
        key: ['eurotronic_host_flags', 'eurotronic_system_mode'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value === 'object') {
                // read current eurotronic_host_flags (we will update some of them)
                await entity.read('hvacThermostat', [0x4008], manufacturerOptions.eurotronic);
                const currentHostFlags = meta.state.eurotronic_host_flags ? meta.state.eurotronic_host_flags : {};

                // get full hostFlag object
                const hostFlags = {...currentHostFlags, ...value};

                // calculate bit value
                let bitValue = 1; // bit 0 always 1
                if (hostFlags.mirror_display) {
                    bitValue |= 1 << 1;
                }
                if (hostFlags.boost) {
                    bitValue |= 1 << 2;
                }
                if (value.hasOwnProperty('window_open') && value.window_open != currentHostFlags.window_open) {
                    if (hostFlags.window_open) {
                        bitValue |= 1 << 5;
                    } else {
                        bitValue |= 1 << 4;
                    }
                }
                if (hostFlags.child_protection) {
                    bitValue |= 1 << 7;
                }

                meta.logger.debug(`eurotronic: host_flags object converted to ${bitValue}`);
                value = bitValue;
            }
            const payload = {0x4008: {value, type: 0x22}};
            await entity.write('hvacThermostat', payload, manufacturerOptions.eurotronic);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', [0x4008], manufacturerOptions.eurotronic);
        },
    },
    eurotronic_error_status: {
        key: ['eurotronic_error_status'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', [0x4002], manufacturerOptions.eurotronic);
        },
    },
    eurotronic_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const val = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            const payload = {0x4003: {value: val, type: 0x29}};
            await entity.write('hvacThermostat', payload, manufacturerOptions.eurotronic);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', [0x4003], manufacturerOptions.eurotronic);
        },
    },
    eurotronic_valve_position: {
        key: ['eurotronic_valve_position', 'valve_position'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {0x4001: {value, type: 0x20}};
            await entity.write('hvacThermostat', payload, manufacturerOptions.eurotronic);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', [0x4001], manufacturerOptions.eurotronic);
        },
    },
    eurotronic_trv_mode: {
        key: ['eurotronic_trv_mode', 'trv_mode'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {0x4000: {value, type: 0x30}};
            await entity.write('hvacThermostat', payload, manufacturerOptions.eurotronic);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', [0x4000], manufacturerOptions.eurotronic);
        },
    },
    sinope_thermostat_occupancy: {
        key: ['thermostat_occupancy'],
        convertSet: async (entity, key, value, meta) => {
            const sinopeOccupancy = {0: 'unoccupied', 1: 'occupied'};
            const SinopeOccupancy = utils.getKey(sinopeOccupancy, value, value, Number);
            await entity.write('hvacThermostat', {SinopeOccupancy});
        },
    },
    sinope_thermostat_backlight_autodim_param: {
        key: ['backlight_auto_dim'],
        convertSet: async (entity, key, value, meta) => {
            const sinopeBacklightParam = {
                0: 'on demand',
                1: 'sensing',
            };
            const SinopeBacklight = utils.getKey(sinopeBacklightParam, value, value, Number);
            await entity.write('hvacThermostat', {SinopeBacklight});
        },
    },
    sinope_thermostat_enable_outdoor_temperature: {
        key: ['enable_outdoor_temperature'],
        convertSet: async (entity, key, value, meta) => {
            if (value.toLowerCase() == 'on') {
                await entity.write('manuSpecificSinope', {outdoorTempToDisplayTimeout: 10800});
            } else if (value.toLowerCase() == 'off') {
                // set timer to 30sec in order to disable outdoor temperature
                await entity.write('manuSpecificSinope', {outdoorTempToDisplayTimeout: 30});
            }
        },
    },
    sinope_thermostat_outdoor_temperature: {
        key: ['thermostat_outdoor_temperature'],
        convertSet: async (entity, key, value, meta) => {
            if (value > -100 && value < 100) {
                await entity.write('manuSpecificSinope', {outdoorTempToDisplay: value * 100});
            }
        },
    },
    sinope_thermostat_time: {
        key: ['thermostat_time'],
        convertSet: async (entity, key, value, meta) => {
            if (value === '') {
                const thermostatDate = new Date();
                const thermostatTimeSec = thermostatDate.getTime() / 1000;
                const thermostatTimezoneOffsetSec = thermostatDate.getTimezoneOffset() * 60;
                const currentTimeToDisplay = Math.round(thermostatTimeSec - thermostatTimezoneOffsetSec - 946684800);
                await entity.write('manuSpecificSinope', {currentTimeToDisplay});
            } else if (value !== '') {
                await entity.write('manuSpecificSinope', {currentTimeToDisplay: value});
            }
        },
    },
    sinope_floor_control_mode: {
        // TH1300ZB specific
        key: ['floor_control_mode'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'string') {
                return;
            }
            const lookup = {'ambiant': 1, 'floor': 2};
            value = value.toLowerCase();
            if (lookup.hasOwnProperty(value)) {
                await entity.write('manuSpecificSinope', {floorControlMode: lookup[value]});
            }
        },
    },
    sinope_ambiant_max_heat_setpoint: {
        // TH1300ZB specific
        key: ['ambiant_max_heat_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            if (value >= 5 && value <= 36) {
                await entity.write('manuSpecificSinope', {ambiantMaxHeatSetpointLimit: value * 100});
            }
        },
    },
    sinope_floor_min_heat_setpoint: {
        // TH1300ZB specific
        key: ['floor_min_heat_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            if (value >= 5 && value <= 36) {
                await entity.write('manuSpecificSinope', {floorMinHeatSetpointLimit: value * 100});
            }
        },
    },
    sinope_floor_max_heat_setpoint: {
        // TH1300ZB specific
        key: ['floor_max_heat_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            if (value >= 5 && value <= 36) {
                await entity.write('manuSpecificSinope', {floorMaxHeatSetpointLimit: value * 100});
            }
        },
    },
    sinope_temperature_sensor: {
        // TH1300ZB specific
        key: ['floor_temperature_sensor'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'string') {
                return;
            }
            const lookup = {'10k': 0, '12k': 1};
            value = value.toLowerCase();
            if (lookup.hasOwnProperty(value)) {
                await entity.write('manuSpecificSinope', {temperatureSensor: lookup[value]});
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('manuSpecificSinope', ['temperatureSensor']);
        },
    },
    sinope_time_format: {
        // TH1300ZB specific
        key: ['time_format'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'string') {
                return;
            }
            const lookup = {'24h': 0, '12h': 1};
            value = value.toLowerCase();
            if (lookup.hasOwnProperty(value)) {
                await entity.write('manuSpecificSinope', {timeFormatToDisplay: lookup[value]});
            }
        },
    },
    sinope_led_intensity_on: {
        // DM2500ZB and SW2500ZB
        key: ['led_intensity_on'],
        convertSet: async (entity, key, value, meta) => {
            if (value >= 0 && value <= 100) {
                await entity.write('manuSpecificSinope', {ledIntensityOn: value});
            }
        },
    },
    sinope_led_intensity_off: {
        // DM2500ZB and SW2500ZB
        key: ['led_intensity_off'],
        convertSet: async (entity, key, value, meta) => {
            if (value >= 0 && value <= 100) {
                await entity.write('manuSpecificSinope', {ledIntensityOff: value});
            }
        },
    },
    sinope_minimum_brightness: {
        // DM2500ZB
        key: ['minimum_brightness'],
        convertSet: async (entity, key, value, meta) => {
            if (value >= 0 && value <= 3000) {
                await entity.write('manuSpecificSinope', {minimumBrightness: value});
            }
        },
    },
    stelpro_thermostat_outdoor_temperature: {
        key: ['thermostat_outdoor_temperature'],
        convertSet: async (entity, key, value, meta) => {
            if (value > -100 && value < 100) {
                await entity.write('hvacThermostat', {StelproOutdoorTemp: value * 100});
            }
        },
    },
    DTB190502A1_LED: {
        key: ['LED'],
        convertSet: async (entity, key, value, meta) => {
            if (value === 'default') {
                value = 1;
            }
            const lookup = {
                'OFF': '0',
                'ON': '1',
            };
            value = lookup[value];
            // Check for valid data
            if (((value >= 0) && value < 2) == false) value = 0;

            const payload = {
                0x4010: {
                    value,
                    type: 0x21,
                },
            };

            await entity.write('genBasic', payload);
        },
    },
    ptvo_switch_trigger: {
        key: ['trigger', 'interval'],
        convertSet: async (entity, key, value, meta) => {
            value = parseInt(value);
            if (!value) {
                return;
            }

            if (key === 'trigger') {
                await entity.command('genOnOff', 'onWithTimedOff', {ctrlbits: 0, ontime: Math.round(value / 100), offwaittime: 0});
            } else if (key === 'interval') {
                await entity.configureReporting('genOnOff', [{
                    attribute: 'onOff',
                    minimumReportInterval: value,
                    maximumReportInterval: value,
                }]);
            }
        },
    },
    ptvo_switch_uart: {
        key: ['action'],
        convertSet: async (entity, key, value, meta) => {
            if (!value) {
                return;
            }
            const payload = {14: {value, type: 0x42}};
            for (const endpoint of meta.device.endpoints) {
                const cluster = 'genMultistateValue';
                if (endpoint.supportsInputCluster(cluster) || endpoint.supportsOutputCluster(cluster)) {
                    await endpoint.write(cluster, payload);
                    return;
                }
            }
            await entity.write('genMultistateValue', payload);
        },
    },
    ptvo_switch_analog_input: {
        key: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'l12', 'l13', 'l14', 'l15', 'l16'],
        convertGet: async (entity, key, meta) => {
            const epId = parseInt(key.substr(1, 2));
            if (utils.hasEndpoints(meta.device, [epId])) {
                const endpoint = meta.device.getEndpoint(epId);
                await endpoint.read('genAnalogInput', ['presentValue', 'description']);
            }
        },
        convertSet: async (entity, key, value, meta) => {
            const epId = parseInt(key.substr(1, 2));
            if (utils.hasEndpoints(meta.device, [epId])) {
                const endpoint = meta.device.getEndpoint(epId);
                let cluster = 'genLevelCtrl';
                if (endpoint.supportsInputCluster(cluster) || endpoint.supportsOutputCluster(cluster)) {
                    const value2 = parseInt(value);
                    if (isNaN(value2)) {
                        return;
                    }
                    const payload = {'currentLevel': value2};
                    await endpoint.write(cluster, payload);
                    return;
                }

                cluster = 'genAnalogInput';
                if (endpoint.supportsInputCluster(cluster) || endpoint.supportsOutputCluster(cluster)) {
                    const value2 = parseFloat(value);
                    if (isNaN(value2)) {
                        return;
                    }
                    const payload = {'presentValue': value2};
                    await endpoint.write(cluster, payload);
                    return;
                }
            }
            return;
        },
    },
    ptvo_switch_light_brightness: {
        key: ['brightness', 'brightness_percent', 'transition'],
        options: [exposes.options.transition()],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'transition') {
                return;
            }
            const cluster = 'genLevelCtrl';
            if (entity.supportsInputCluster(cluster) || entity.supportsOutputCluster(cluster)) {
                const message = meta.message;

                let brightness = undefined;
                if (message.hasOwnProperty('brightness')) {
                    brightness = Number(message.brightness);
                } else if (message.hasOwnProperty('brightness_percent')) brightness = Math.round(Number(message.brightness_percent) * 2.55);

                if ((brightness !== undefined) && (brightness === 0)) {
                    message.state = 'off';
                    message.brightness = 1;
                }
                return await converters.light_onoff_brightness.convertSet(entity, key, value, meta);
            } else {
                throw new Error('LevelControl not supported on this endpoint.');
            }
        },
        convertGet: async (entity, key, meta) => {
            const cluster = 'genLevelCtrl';
            if (entity.supportsInputCluster(cluster) || entity.supportsOutputCluster(cluster)) {
                return await converters.light_onoff_brightness.convertGet(entity, key, meta);
            } else {
                throw new Error('LevelControl not supported on this endpoint.');
            }
        },
    },
    ubisys_configure_j1: {
        key: ['configure_j1'],
        convertSet: async (entity, key, value, meta) => {
            const log = (message) => {
                meta.logger.warn(`ubisys: ${message}`);
            };
            const sleepSeconds = async (s) => {
                return new Promise((resolve) => setTimeout(resolve, s * 1000));
            };
            const waitUntilStopped = async () => {
                let operationalStatus = 0;
                do {
                    await sleepSeconds(2);
                    operationalStatus = (await entity.read('closuresWindowCovering',
                        ['operationalStatus'])).operationalStatus;
                } while (operationalStatus != 0);
                await sleepSeconds(2);
            };
            const writeAttrFromJson = async (attr, jsonAttr = attr, converterFunc, delaySecondsAfter) => {
                if (jsonAttr.startsWith('ubisys')) {
                    jsonAttr = jsonAttr.substring(6, 1).toLowerCase + jsonAttr.substring(7);
                }
                if (value.hasOwnProperty(jsonAttr)) {
                    let attrValue = value[jsonAttr];
                    if (converterFunc) {
                        attrValue = converterFunc(attrValue);
                    }
                    const attributes = {};
                    attributes[attr] = attrValue;
                    await entity.write('closuresWindowCovering', attributes, manufacturerOptions.ubisys);
                    if (delaySecondsAfter) {
                        await sleepSeconds(delaySecondsAfter);
                    }
                }
            };
            const stepsPerSecond = value.steps_per_second || 50;
            const hasCalibrate = value.hasOwnProperty('calibrate');
            // cancel any running calibration
            let mode = (await entity.read('closuresWindowCovering', ['windowCoveringMode'])).windowCoveringMode;
            const modeCalibrationBitMask = 0x02;
            if (mode & modeCalibrationBitMask) {
                await entity.write('closuresWindowCovering', {windowCoveringMode: mode & ~modeCalibrationBitMask});
                await sleepSeconds(2);
            }
            // delay a bit if reconfiguring basic configuration attributes
            await writeAttrFromJson('windowCoveringType', undefined, undefined, 2);
            await writeAttrFromJson('configStatus', undefined, undefined, 2);
            if (await writeAttrFromJson('windowCoveringMode', undefined, undefined, 2)) {
                mode = value['windowCoveringMode'];
            }
            if (hasCalibrate) {
                log('Cover calibration starting...');
                // first of all, move to top position to not confuse calibration later
                log('  Moving cover to top position to get a good starting point...');
                await entity.command('closuresWindowCovering', 'upOpen');
                await waitUntilStopped();
                log('  Settings some attributes...');
                // reset attributes
                await entity.write('closuresWindowCovering', {
                    installedOpenLimitLiftCm: 0,
                    installedClosedLimitLiftCm: 240,
                    installedOpenLimitTiltDdegree: 0,
                    installedClosedLimitTiltDdegree: 900,
                    ubisysLiftToTiltTransitionSteps: 0xffff,
                    ubisysTotalSteps: 0xffff,
                    ubisysLiftToTiltTransitionSteps2: 0xffff,
                    ubisysTotalSteps2: 0xffff,
                }, manufacturerOptions.ubisys);
                // enable calibration mode
                await sleepSeconds(2);
                await entity.write('closuresWindowCovering', {windowCoveringMode: mode | modeCalibrationBitMask});
                await sleepSeconds(2);
                // move down a bit and back up to detect upper limit
                log('  Moving cover down a bit...');
                await entity.command('closuresWindowCovering', 'downClose');
                await sleepSeconds(5);
                await entity.command('closuresWindowCovering', 'stop');
                await sleepSeconds(2);
                log('  Moving up again to detect upper limit...');
                await entity.command('closuresWindowCovering', 'upOpen');
                await waitUntilStopped();
                log('  Moving down to count steps from open to closed...');
                await entity.command('closuresWindowCovering', 'downClose');
                await waitUntilStopped();
                log('  Moving up to count steps from closed to open...');
                await entity.command('closuresWindowCovering', 'upOpen');
                await waitUntilStopped();
            }
            // now write any attribute values present in JSON
            await writeAttrFromJson('installedOpenLimitLiftCm');
            await writeAttrFromJson('installedClosedLimitLiftCm');
            await writeAttrFromJson('installedOpenLimitTiltDdegree');
            await writeAttrFromJson('installedClosedLimitTiltDdegree');
            await writeAttrFromJson('ubisysTurnaroundGuardTime');
            await writeAttrFromJson('ubisysLiftToTiltTransitionSteps');
            await writeAttrFromJson('ubisysTotalSteps');
            await writeAttrFromJson('ubisysLiftToTiltTransitionSteps2');
            await writeAttrFromJson('ubisysTotalSteps2');
            await writeAttrFromJson('ubisysAdditionalSteps');
            await writeAttrFromJson('ubisysInactivePowerThreshold');
            await writeAttrFromJson('ubisysStartupSteps');
            // some convenience functions to not have to calculate
            await writeAttrFromJson('ubisysTotalSteps', 'open_to_closed_s', (s) => s * stepsPerSecond);
            await writeAttrFromJson('ubisysTotalSteps2', 'closed_to_open_s', (s) => s * stepsPerSecond);
            await writeAttrFromJson('ubisysLiftToTiltTransitionSteps', 'lift_to_tilt_transition_ms',
                (s) => s * stepsPerSecond / 1000);
            await writeAttrFromJson('ubisysLiftToTiltTransitionSteps2', 'lift_to_tilt_transition_ms',
                (s) => s * stepsPerSecond / 1000);
            if (hasCalibrate) {
                log('  Finalizing calibration...');
                // disable calibration mode again
                await sleepSeconds(2);
                await entity.write('closuresWindowCovering', {windowCoveringMode: mode & ~modeCalibrationBitMask});
                await sleepSeconds(2);
                // re-read and dump all relevant attributes
                log('  Done - will now read back the results.');
                converters.ubisys_configure_j1.convertGet(entity, key, meta);
            }
        },
        convertGet: async (entity, key, meta) => {
            const log = (json) => {
                meta.logger.warn(`ubisys: Cover configuration read: ${JSON.stringify(json)}`);
            };
            log(await entity.read('closuresWindowCovering', [
                'windowCoveringType',
                'physicalClosedLimitLiftCm',
                'physicalClosedLimitTiltDdegree',
                'installedOpenLimitLiftCm',
                'installedClosedLimitLiftCm',
                'installedOpenLimitTiltDdegree',
                'installedClosedLimitTiltDdegree',
            ]));
            log(await entity.read('closuresWindowCovering', [
                'configStatus',
                'windowCoveringMode',
                'currentPositionLiftPercentage',
                'currentPositionLiftCm',
                'currentPositionTiltPercentage',
                'currentPositionTiltDdegree',
                'operationalStatus',
            ]));
            log(await entity.read('closuresWindowCovering', [
                'ubisysTurnaroundGuardTime',
                'ubisysLiftToTiltTransitionSteps',
                'ubisysTotalSteps',
                'ubisysLiftToTiltTransitionSteps2',
                'ubisysTotalSteps2',
                'ubisysAdditionalSteps',
                'ubisysInactivePowerThreshold',
                'ubisysStartupSteps',
            ], manufacturerOptions.ubisys));
        },
    },
    ubisys_dimmer_setup: {
        key: ['capabilities_forward_phase_control',
            'capabilities_reverse_phase_control',
            'capabilities_reactance_discriminator',
            'capabilities_configurable_curve',
            'capabilities_overload_detection',
            'status_forward_phase_control',
            'status_reverse_phase_control',
            'status_overload',
            'status_capacitive_load',
            'status_inductive_load',
            'mode_phase_control'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'mode_phase_control') {
                const phaseControl = value.toLowerCase();
                const phaseControlValues = {'automatic': 0, 'forward': 1, 'reverse': 2};
                utils.validateValue(phaseControl, Object.keys(phaseControlValues));
                await entity.write('manuSpecificUbisysDimmerSetup',
                    {'mode': phaseControlValues[phaseControl]}, manufacturerOptions.ubisysNull);
            }
            converters.ubisys_dimmer_setup.convertGet(entity, key, meta);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('manuSpecificUbisysDimmerSetup', ['capabilities'], manufacturerOptions.ubisysNull);
            await entity.read('manuSpecificUbisysDimmerSetup', ['status'], manufacturerOptions.ubisysNull);
            await entity.read('manuSpecificUbisysDimmerSetup', ['mode'], manufacturerOptions.ubisysNull);
        },
    },
    ubisys_dimmer_setup_genLevelCtrl: {
        key: ['minimum_on_level'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'minimum_on_level') {
                await entity.write('genLevelCtrl', {'ubisysMinimumOnLevel': value}, manufacturerOptions.ubisys);
            }
            converters.ubisys_dimmer_setup_genLevelCtrl.convertGet(entity, key, meta);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genLevelCtrl', ['ubisysMinimumOnLevel'], manufacturerOptions.ubisys);
        },
    },
    ubisys_device_setup: {
        key: ['configure_device_setup'],
        convertSet: async (entity, key, value, meta) => {
            const devMgmtEp = meta.device.getEndpoint(232);

            if (value.hasOwnProperty('input_configurations')) {
                // example: [0, 0, 0, 0]
                await devMgmtEp.write(
                    'manuSpecificUbisysDeviceSetup',
                    {'inputConfigurations': {elementType: 'data8', elements: value.input_configurations}},
                    manufacturerOptions.ubisysNull,
                );
            }

            if (value.hasOwnProperty('input_actions')) {
                // example (default for C4): [[0,13,1,6,0,2], [1,13,2,6,0,2], [2,13,3,6,0,2], [3,13,4,6,0,2]]
                await devMgmtEp.write(
                    'manuSpecificUbisysDeviceSetup',
                    {'inputActions': {elementType: 'octetStr', elements: value.input_actions}},
                    manufacturerOptions.ubisysNull,
                );
            }

            if (value.hasOwnProperty('input_action_templates')) {
                const templateTypes = {
                    // source: "ZigBee Device Physical Input Configurations Integrator’s Guide"
                    // (can be obtained directly from ubisys upon request)
                    'toggle': {
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x06, 0x00, 0x02],
                        ],
                    },
                    'toggle_switch': {
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x06, 0x00, 0x02],
                            [input, 0x03, endpoint, 0x06, 0x00, 0x02],
                        ],
                    },
                    'on_off_switch': {
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x06, 0x00, 0x01],
                            [input, 0x03, endpoint, 0x06, 0x00, 0x00],
                        ],
                    },
                    'on': {
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x06, 0x00, 0x01],
                        ],
                    },
                    'off': {
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x06, 0x00, 0x00],
                        ],
                    },
                    'dimmer_single': {
                        getInputActions: (input, endpoint, template) => {
                            const moveUpCmd = template.no_onoff || template.no_onoff_up ? 0x01 : 0x05;
                            const moveDownCmd = template.no_onoff || template.no_onoff_down ? 0x01 : 0x05;
                            const moveRate = template.rate || 50;
                            return [
                                [input, 0x07, endpoint, 0x06, 0x00, 0x02],
                                [input, 0x86, endpoint, 0x08, 0x00, moveUpCmd, 0x00, moveRate],
                                [input, 0xC6, endpoint, 0x08, 0x00, moveDownCmd, 0x01, moveRate],
                                [input, 0x0B, endpoint, 0x08, 0x00, 0x03],
                            ];
                        },
                    },
                    'dimmer_double': {
                        doubleInputs: true,
                        getInputActions: (inputs, endpoint, template) => {
                            const moveUpCmd = template.no_onoff || template.no_onoff_up ? 0x01 : 0x05;
                            const moveDownCmd = template.no_onoff || template.no_onoff_down ? 0x01 : 0x05;
                            const moveRate = template.rate || 50;
                            return [
                                [inputs[0], 0x07, endpoint, 0x06, 0x00, 0x01],
                                [inputs[0], 0x06, endpoint, 0x08, 0x00, moveUpCmd, 0x00, moveRate],
                                [inputs[0], 0x0B, endpoint, 0x08, 0x00, 0x03],
                                [inputs[1], 0x07, endpoint, 0x06, 0x00, 0x00],
                                [inputs[1], 0x06, endpoint, 0x08, 0x00, moveDownCmd, 0x01, moveRate],
                                [inputs[1], 0x0B, endpoint, 0x08, 0x00, 0x03],
                            ];
                        },
                    },
                    'cover': {
                        cover: true,
                        doubleInputs: true,
                        getInputActions: (inputs, endpoint) => [
                            [inputs[0], 0x0D, endpoint, 0x02, 0x01, 0x00],
                            [inputs[0], 0x07, endpoint, 0x02, 0x01, 0x02],
                            [inputs[1], 0x0D, endpoint, 0x02, 0x01, 0x01],
                            [inputs[1], 0x07, endpoint, 0x02, 0x01, 0x02],
                        ],
                    },
                    'cover_switch': {
                        cover: true,
                        doubleInputs: true,
                        getInputActions: (inputs, endpoint) => [
                            [inputs[0], 0x0D, endpoint, 0x02, 0x01, 0x00],
                            [inputs[0], 0x03, endpoint, 0x02, 0x01, 0x02],
                            [inputs[1], 0x0D, endpoint, 0x02, 0x01, 0x01],
                            [inputs[1], 0x03, endpoint, 0x02, 0x01, 0x02],
                        ],
                    },
                    'cover_up': {
                        cover: true,
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x02, 0x01, 0x00],
                        ],
                    },
                    'cover_down': {
                        cover: true,
                        getInputActions: (input, endpoint) => [
                            [input, 0x0D, endpoint, 0x02, 0x01, 0x01],
                        ],
                    },
                    'scene': {
                        scene: true,
                        getInputActions: (input, endpoint, groupId, sceneId) => [
                            [input, 0x07, endpoint, 0x05, 0x00, 0x05, groupId & 0xff, groupId >> 8, sceneId],
                        ],
                        getInputActions2: (input, endpoint, groupId, sceneId) => [
                            [input, 0x06, endpoint, 0x05, 0x00, 0x05, groupId & 0xff, groupId >> 8, sceneId],
                        ],
                    },
                    'scene_switch': {
                        scene: true,
                        getInputActions: (input, endpoint, groupId, sceneId) => [
                            [input, 0x0D, endpoint, 0x05, 0x00, 0x05, groupId & 0xff, groupId >> 8, sceneId],
                        ],
                        getInputActions2: (input, endpoint, groupId, sceneId) => [
                            [input, 0x03, endpoint, 0x05, 0x00, 0x05, groupId & 0xff, groupId >> 8, sceneId],
                        ],
                    },
                };

                // first input
                let input = 0;
                // first client endpoint - depends on actual device
                let endpoint = {'S1': 2, 'S2': 3, 'D1': 2, 'J1': 2, 'C4': 1}[meta.mapped.model];
                // default group id
                let groupId = 0;

                const templates = Array.isArray(value.input_action_templates) ? value.input_action_templates :
                    [value.input_action_templates];
                let resultingInputActions = [];
                for (const template of templates) {
                    const templateType = templateTypes[template.type];
                    if (!templateType) {
                        throw new Error(`input_action_templates: Template type '${template.type}' is not valid ` +
                            `(valid types: ${Object.keys(templateTypes)})`);
                    }

                    if (template.hasOwnProperty('input')) {
                        input = template.input;
                    }
                    if (template.hasOwnProperty('endpoint')) {
                        endpoint = template.endpoint;
                    }
                    // C4 cover endpoints only start at 5
                    if (templateType.cover && meta.mapped.model === 'C4' && endpoint < 5) {
                        endpoint += 4;
                    }

                    let inputActions;
                    if (!templateType.doubleInputs) {
                        if (!templateType.scene) {
                            // single input, no scene(s)
                            inputActions = templateType.getInputActions(input, endpoint, template);
                        } else {
                            // scene(s) (always single input)
                            if (!template.hasOwnProperty('scene_id')) {
                                throw new Error(`input_action_templates: Need an attribute 'scene_id' for '${template.type}'`);
                            }
                            if (template.hasOwnProperty('group_id')) {
                                groupId = template.group_id;
                            }
                            inputActions = templateType.getInputActions(input, endpoint, groupId, template.scene_id);

                            if (template.hasOwnProperty('scene_id_2')) {
                                if (template.hasOwnProperty('group_id_2')) {
                                    groupId = template.group_id_2;
                                }
                                inputActions = inputActions.concat(templateType.getInputActions2(input, endpoint, groupId,
                                    template.scene_id_2));
                            }
                        }
                    } else {
                        // double inputs
                        input = template.hasOwnProperty('inputs') ? template.inputs : [input, input + 1];
                        inputActions = templateType.getInputActions(input, endpoint, template);
                    }
                    resultingInputActions = resultingInputActions.concat(inputActions);

                    meta.logger.warn(`ubisys: Using input(s) ${input} and endpoint ${endpoint} for '${template.type}'.`);
                    // input might by now be an array (in case of double inputs)
                    input = (Array.isArray(input) ? Math.max(...input) : input) + 1;
                    endpoint += 1;
                }

                meta.logger.debug(`ubisys: input_actions to be sent to '${meta.options.friendlyName}': ` +
                    JSON.stringify(resultingInputActions));
                await devMgmtEp.write(
                    'manuSpecificUbisysDeviceSetup',
                    {'inputActions': {elementType: 'octetStr', elements: resultingInputActions}},
                    manufacturerOptions.ubisysNull,
                );
            }

            // re-read effective settings and dump them to the log
            converters.ubisys_device_setup.convertGet(entity, key, meta);
        },

        convertGet: async (entity, key, meta) => {
            const log = (dataRead) => {
                meta.logger.warn(
                    `ubisys: Device setup read for '${meta.options.friendly_name}': ${JSON.stringify(utils.toSnakeCase(dataRead))}`);
            };
            const devMgmtEp = meta.device.getEndpoint(232);
            log(await devMgmtEp.read('manuSpecificUbisysDeviceSetup', ['inputConfigurations'], manufacturerOptions.ubisysNull));
            log(await devMgmtEp.read('manuSpecificUbisysDeviceSetup', ['inputActions'], manufacturerOptions.ubisysNull));
        },
    },
    tint_scene: {
        key: ['tint_scene'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('genBasic', {0x4005: {value, type: 0x20}}, manufacturerOptions.tint);
        },
    },
    bticino_4027C_cover_state: {
        key: ['state'],
        options: [exposes.options.invert_cover()],
        convertSet: async (entity, key, value, meta) => {
            const invert = !(utils.getMetaValue(entity, meta.mapped, 'coverInverted', 'allEqual', false) ?
                !meta.options.invert_cover : meta.options.invert_cover);
            const lookup = invert ?
                {'open': 'upOpen', 'close': 'downClose', 'stop': 'stop', 'on': 'upOpen', 'off': 'downClose'} :
                {'open': 'downClose', 'close': 'upOpen', 'stop': 'stop', 'on': 'downClose', 'off': 'upOpen'};

            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));

            let position = 50;
            if (value.localeCompare('open') == 0) {
                position = 100;
            } else if (value.localeCompare('close') == 0) {
                position = 0;
            }
            await entity.command('closuresWindowCovering', lookup[value], {}, utils.getOptions(meta.mapped, entity));
            return {state: {position}, readAfterWriteTime: 0};
        },
    },
    bticino_4027C_cover_position: {
        key: ['position'],
        options: [exposes.options.invert_cover(), exposes.options.no_position_support()],
        convertSet: async (entity, key, value, meta) => {
            const invert = !(utils.getMetaValue(entity, meta.mapped, 'coverInverted', 'allEqual', false) ?
                !meta.options.invert_cover : meta.options.invert_cover);
            let newPosition = value;
            if (meta.options.no_position_support) {
                newPosition = value >= 50 ? 100 : 0;
            }
            const position = newPosition;
            if (invert) {
                newPosition = 100 - newPosition;
            }
            await entity.command('closuresWindowCovering', 'goToLiftPercentage', {percentageliftvalue: newPosition},
                utils.getOptions(meta.mapped, entity));
            return {state: {['position']: position}, readAfterWriteTime: 0};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresWindowCovering', ['currentPositionLiftPercentage']);
        },
    },
    legrand_identify: {
        key: ['identify'],
        convertSet: async (entity, key, value, meta) => {
            if (!value.timeout) {
                const effects = {
                    'blink3': 0x00,
                    'fixed': 0x01,
                    'blinkgreen': 0x02,
                    'blinkblue': 0x03,
                };
                // only works for blink3 & fixed
                const colors = {
                    'default': 0x00,
                    'red': 0x01,
                    'green': 0x02,
                    'blue': 0x03,
                    'lightblue': 0x04,
                    'yellow': 0x05,
                    'pink': 0x06,
                    'white': 0x07,
                };

                const selectedEffect = effects[value.effect] | effects['blink3'];
                const selectedColor = colors[value.color] | colors['default'];

                const payload = {effectid: selectedEffect, effectvariant: selectedColor};
                await entity.command('genIdentify', 'triggerEffect', payload, {});
            } else {
                await entity.command('genIdentify', 'identify', {identifytime: 10}, {});
            }
        },
    },
    legrand_settingAlwaysEnableLed: {
        // connected power outlet is on attribute 2 and not 1
        key: ['permanent_led'],
        convertSet: async (entity, key, value, meta) => {
            // enable or disable the LED (blue) when permitJoin=false (LED off)
            const enableLedIfOn = value === 'ON' || (value === 'OFF' ? false : !!value);
            const payload = {1: {value: enableLedIfOn, type: 16}};
            await entity.write('manuSpecificLegrandDevices', payload, manufacturerOptions.legrand);
        },
    },
    legrand_settingEnableLedIfOn: {
        key: ['led_when_on'],
        convertSet: async (entity, key, value, meta) => {
            // enable the LED when the light object is "doing something"
            // on the light switch, the LED is on when the light is on,
            // on the shutter switch, the LED is on when te shutter is moving
            const enableLedIfOn = value === 'ON' || (value === 'OFF' ? false : !!value);
            const payload = {2: {value: enableLedIfOn, type: 16}};
            await entity.write('manuSpecificLegrandDevices', payload, manufacturerOptions.legrand);
        },
    },
    legrand_settingEnableDimmer: {
        key: ['dimmer_enabled'],
        convertSet: async (entity, key, value, meta) => {
            // enable the dimmer, requires a recent firmware on the device
            const enableDimmer = value === 'ON' || (value === 'OFF' ? false : !!value);
            const payload = {0: {value: enableDimmer ? 0x0101 : 0x0100, type: 9}};
            await entity.write('manuSpecificLegrandDevices', payload, manufacturerOptions.legrand);
        },
    },
    legrand_deviceMode: {
        key: ['device_mode'],
        convertSet: async (entity, key, value, meta) => {
            // enable the dimmer, requires a recent firmware on the device
            const lookup = {
                // dimmer
                'dimmer_on': 0x0101,
                'dimmer_off': 0x0100,
                // contactor
                'switch': 0x0003,
                'auto': 0x0004,
                // pilot wire
                'pilot_on': 0x0002,
                'pilot_off': 0x0001,
            };

            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));
            const payload = {0: {value: lookup[value], type: 9}};
            await entity.write('manuSpecificLegrandDevices', payload, manufacturerOptions.legrand);
            return {state: {'device_mode': value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('manuSpecificLegrandDevices', [0x0000, 0x0001, 0x0002], manufacturerOptions.legrand);
        },
    },
    legrand_cableOutletMode: {
        key: ['cable_outlet_mode'],
        convertSet: async (entity, key, value, meta) => {
            meta.logger.warn('Feature under development !');
        },
        convertGet: async (entity, key, meta) => {
            await entity.read(64576, [0x0000], manufacturerOptions.legrand);
        },
    },
    legrand_powerAlarm: {
        key: ['power_alarm'],
        convertSet: async (entity, key, value, meta) => {
            const enableAlarm = (value === 'DISABLE' || value === false ? false : true);
            const payloadBolean = {0xf001: {value: enableAlarm ? 0x01 : 0x00, type: 0x10}};
            const payloadValue = {0xf002: {value: value, type: 0x29}};
            await entity.write('haElectricalMeasurement', payloadValue);
            await entity.write('haElectricalMeasurement', payloadBolean);
            // To have consistent information in the system.
            await entity.read('haElectricalMeasurement', [0xf000, 0xf001, 0xf002]);
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('haElectricalMeasurement', [0xf000, 0xf001, 0xf002]);
        },
    },
    etop_thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            switch (value) {
            case 'off':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.state, false);
                break;
            case 'heat':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.state, true);
                await utils.sleep(500);
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, 0 /* manual */);
                break;
            case 'auto':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.state, true);
                await utils.sleep(500);
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, 2 /* auto */);
                break;
            }
        },
    },
    etop_thermostat_away_mode: {
        key: ['away_mode'],
        convertSet: async (entity, key, value, meta) => {
            switch (value) {
            case 'ON':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.state, true);
                await utils.sleep(500);
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, 1 /* away */);
                break;
            case 'OFF':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, 0 /* manual */);
                break;
            }
        },
    },
    tuya_thermostat_weekly_schedule: {
        key: ['weekly_schedule'],
        convertSet: async (entity, key, value, meta) => {
            const thermostatMeta = utils.getMetaValue(entity, meta.mapped, 'thermostat');
            const maxTransitions = thermostatMeta.weeklyScheduleMaxTransitions;
            const supportedModes = thermostatMeta.weeklyScheduleSupportedModes;
            const firstDayDpId = thermostatMeta.weeklyScheduleFirstDayDpId;
            let conversion = 'generic';
            if (thermostatMeta.hasOwnProperty('weeklyScheduleConversion')) {
                conversion = thermostatMeta.weeklyScheduleConversion;
            }

            function transitionToData(transition) {
                // Later it is possible to move converter to meta or to other place outside if other type of converter
                // will be needed for other device. Currently this converter is based on ETOP HT-08 thermostat.
                // see also fromZigbee.tuya_thermostat_weekly_schedule()
                const minutesSinceMidnight = transition.transitionTime;
                const heatSetpoint = Math.floor(transition.heatSetpoint * 10);
                return [
                    (minutesSinceMidnight & 0xff00) >> 8,
                    minutesSinceMidnight & 0xff,
                    (heatSetpoint & 0xff00) >> 8,
                    heatSetpoint & 0xff,
                ];
            }

            for (const [, daySchedule] of Object.entries(value)) {
                const dayofweek = parseInt(daySchedule.dayofweek);
                const numoftrans = parseInt(daySchedule.numoftrans);
                let transitions = [...daySchedule.transitions];
                const mode = parseInt(daySchedule.mode);
                if (!supportedModes.includes(mode)) {
                    throw new Error(`Invalid mode: ${mode} for device ${meta.options.friendly_name}`);
                }
                if (numoftrans != transitions.length) {
                    throw new Error(`Invalid numoftrans provided. Real: ${transitions.length} ` +
                        `provided ${numoftrans} for device ${meta.options.friendly_name}`);
                }
                if (transitions.length > maxTransitions) {
                    throw new Error(`Too more transitions provided. Provided: ${transitions.length} ` +
                        `but supports only ${numoftrans} for device ${meta.options.friendly_name}`);
                }
                if (transitions.length < maxTransitions) {
                    meta.logger.warn(`Padding transitions from ${transitions.length} ` +
                        `to ${maxTransitions} with last item for device ${meta.options.friendly_name}`);
                    const lastTransition = transitions[transitions.length - 1];
                    while (transitions.length != maxTransitions) {
                        transitions = [...transitions, lastTransition];
                    }
                }
                const payload = [];
                if (conversion == 'saswell') {
                    // Single data point for setting schedule
                    // [
                    //     bitmap of days: |  7|  6|  5|  4|  3|  2|  1|
                    //                     |Sat|Fri|Thu|Wed|Tue|Mon|Sun|,
                    //     schedule mode - see tuya.thermostatScheduleMode, currently
                    //                     no known devices support modes other than "7 day"
                    //     4 transitions:
                    //       minutes from midnight high byte
                    //       minutes from midnight low byte
                    //       temperature * 10 high byte
                    //       temperature * 10 low byte
                    // ]
                    payload.push(1 << (dayofweek - 1), 4);
                }
                transitions.forEach((transition) => {
                    payload.push(...transitionToData(transition));
                });
                if (conversion == 'saswell') {
                    await tuya.sendDataPointRaw(
                        entity,
                        tuya.dataPoints.saswellScheduleSet,
                        payload);
                } else {
                    await tuya.sendDataPointRaw(
                        entity,
                        firstDayDpId - 1 + dayofweek,
                        payload);
                }
            }
        },
    },
    tuya_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.childLock, value === 'LOCK');
        },
    },
    tuya_thermostat_window_detection: {
        key: ['window_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointRaw(
                entity,
                tuya.dataPoints.windowDetection,
                [value === 'ON' ? 1 : 0]);
        },
    },
    siterwell_thermostat_window_detection: {
        key: ['window_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(
                entity,
                tuya.dataPoints.siterwellWindowDetection,
                value === 'ON');
        },
    },
    tuya_thermostat_valve_detection: {
        key: ['valve_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.valveDetection, value === 'ON');
        },
    },
    tuya_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value * 10);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.heatingSetpoint, temp);
        },
    },
    tuya_thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            const modeId = utils.getKey(utils.getMetaValue(entity, meta.mapped, 'tuyaThermostatSystemMode'), value, null, Number);
            if (modeId !== null) {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, parseInt(modeId));
            } else {
                throw new Error(`TRV system mode ${value} is not recognized.`);
            }
        },
    },
    tuya_thermostat_preset: {
        key: ['preset'],
        convertSet: async (entity, key, value, meta) => {
            const presetId = utils.getKey(utils.getMetaValue(entity, meta.mapped, 'tuyaThermostatPreset'), value, null, Number);
            if (presetId !== null) {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, parseInt(presetId));
            } else {
                throw new Error(`TRV preset ${value} is not recognized.`);
            }
        },
    },
    tuya_thermostat_away_mode: {
        key: ['away_mode'],
        convertSet: async (entity, key, value, meta) => {
            // HA has special behavior for the away mode
            const awayPresetId = utils.getKey(utils.getMetaValue(entity, meta.mapped, 'tuyaThermostatPreset'), 'away', null, Number);
            const schedulePresetId = utils.getKey(
                utils.getMetaValue(entity, meta.mapped, 'tuyaThermostatPreset'), 'schedule', null, Number,
            );
            if (awayPresetId !== null) {
                if (value == 'ON') {
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, parseInt(awayPresetId));
                } else if (schedulePresetId != null) {
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.mode, parseInt(schedulePresetId));
                }
                // In case 'OFF' tuya_thermostat_preset() should be called with another preset
            } else {
                throw new Error(`TRV preset ${value} is not recognized.`);
            }
        },
    },
    tuya_thermostat_fan_mode: {
        key: ['fan_mode'],
        convertSet: async (entity, key, value, meta) => {
            const modeId = utils.getKey(tuya.fanModes, value, null, Number);
            if (modeId !== null) {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.fanMode, parseInt(modeId));
            } else {
                throw new Error(`TRV fan mode ${value} is not recognized.`);
            }
        },
    },
    tuya_thermostat_auto_lock: {
        key: ['auto_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.autoLock, value === 'AUTO');
        },
    },
    tuya_thermostat_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            let temp = Math.round(value * 10);
            if (temp < 0) {
                temp = 0xFFFFFFFF + temp + 1;
            }
            await tuya.sendDataPointValue(entity, tuya.dataPoints.tempCalibration, temp);
        },
    },
    tuya_thermostat_min_temp: {
        key: ['min_temperature'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.minTemp, value);
        },
    },
    tuya_thermostat_max_temp: {
        key: ['max_temperature'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.maxTemp, value);
        },
    },
    tuya_thermostat_boost_time: {
        key: ['boost_time'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.boostTime, value);
        },
    },
    tuya_thermostat_comfort_temp: {
        key: ['comfort_temperature'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.comfortTemp, value);
        },
    },
    tuya_thermostat_eco_temp: {
        key: ['eco_temperature'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointValue(entity, tuya.dataPoints.ecoTemp, value);
        },
    },
    tuya_thermostat_force: {
        key: ['force'],
        convertSet: async (entity, key, value, meta) => {
            const modeId = utils.getKey(tuya.thermostatForceMode, value, null, Number);
            if (modeId !== null) {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.forceMode, parseInt(modeId));
            } else {
                throw new Error(`TRV force mode ${value} is not recognized.`);
            }
        },
    },
    tuya_thermostat_force_to_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            const modeId = utils.getKey(utils.getMetaValue(entity, meta.mapped, 'tuyaThermostatSystemMode'), value, null, Number);
            if (modeId !== null) {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.forceMode, parseInt(modeId));
            } else {
                throw new Error(`TRV system mode ${value} is not recognized.`);
            }
        },
    },
    tuya_thermostat_away_preset: {
        key: ['away_preset_temperature', 'away_preset_days'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'away_preset_days':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.awayDays, value);
                break;
            case 'away_preset_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.awayTemp, value);
                break;
            }
        },
    },
    tuya_thermostat_window_detect: { // payload example { "detect":"OFF", "temperature":5, "minutes":8}
        key: ['window_detect'],
        convertSet: async (entity, key, value, meta) => {
            const detect = value.detect.toUpperCase() === 'ON' ? 1 : 0;
            await tuya.sendDataPointRaw(entity, tuya.dataPoints.windowDetection, [detect, value.temperature, value.minutes]);
        },
    },
    tuya_thermostat_schedule: { // payload example {"holidays":[{"hour":6,"minute":0,"temperature":20},{"hour":8,"minute":0,....  6x
        key: ['schedule'],
        convertSet: async (entity, key, value, meta) => {
            const prob = Object.keys(value)[0]; // "workdays" or "holidays"
            if ((prob === 'workdays') || (prob === 'holidays')) {
                const dpId =
                    (prob === 'workdays') ?
                        tuya.dataPoints.scheduleWorkday :
                        tuya.dataPoints.scheduleHoliday;
                const payload = [];
                for (let i = 0; i < 6; i++) {
                    if ((value[prob][i].hour >= 0) && (value[prob][i].hour < 24)) {
                        payload[i * 3] = value[prob][i].hour;
                    }
                    if ((value[prob][i].minute >= 0) && (value[prob][i].minute < 60)) {
                        payload[i * 3 + 1] = value[prob][i].minute;
                    }
                    if ((value[prob][i].temperature >= 5) && (value[prob][i].temperature < 35)) {
                        payload[i * 3 + 2] = value[prob][i].temperature;
                    }
                }
                tuya.sendDataPointRaw(entity, dpId, payload);
            }
        },
    },
    tuya_thermostat_schedule_programming_mode: { // payload example "00:20/5°C 01:20/5°C 6:59/15°C 18:00/5°C 20:00/5°C 23:30/5°C"
        key: ['workdays_schedule', 'holidays_schedule'],
        convertSet: async (entity, key, value, meta) => {
            const dpId =
                (key === 'workdays_schedule') ?
                    tuya.dataPoints.scheduleWorkday :
                    tuya.dataPoints.scheduleHoliday;
            const payload = [];
            const items = value.split(' ');

            for (let i = 0; i < 6; i++) {
                const hourTemperature = items[i].split('/');
                const hourMinute = hourTemperature[0].split(':', 2);
                const hour = parseInt(hourMinute[0]);
                const minute = parseInt(hourMinute[1]);
                const temperature = parseInt(hourTemperature[1]);

                if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60 || temperature < 5 || temperature >= 35) {
                    throw new Error('Invalid hour, minute or temperature of:' + items[i]);
                }

                payload[i*3] = hour;
                payload[i*3+1] = minute;
                payload[i*3+2] = temperature;
            }
            tuya.sendDataPointRaw(entity, dpId, payload);
        },
    },
    tuya_thermostat_week: {
        key: ['week'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'5+2': 0, '6+1': 1, '7': 2};
            const week = lookup[value];
            await tuya.sendDataPointEnum(entity, tuya.dataPoints.weekFormat, week);
            return {state: {week: value}};
        },
    },
    tuya_cover_control: {
        key: ['state', 'position'],
        options: [exposes.options.invert_cover()],
        convertSet: async (entity, key, value, meta) => {
            // Protocol description
            // https://github.com/Koenkk/zigbee-herdsman-converters/issues/1159#issuecomment-614659802

            if (key === 'position') {
                if (value >= 0 && value <= 100) {
                    const invert = tuya.isCoverInverted(meta.device.manufacturerName) ?
                        !meta.options.invert_cover : meta.options.invert_cover;

                    value = invert ? 100 - value : value;
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.coverPosition, value);
                } else {
                    throw new Error('TuYa_cover_control: Curtain motor position is out of range');
                }
            } else if (key === 'state') {
                const stateEnums = tuya.getCoverStateEnums(meta.device.manufacturerName);
                meta.logger.debug(`TuYa_cover_control: Using state enums for ${meta.device.manufacturerName}:
                ${JSON.stringify(stateEnums)}`);

                value = value.toLowerCase();
                switch (value) {
                case 'close':
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.state, stateEnums.close);
                    break;
                case 'open':
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.state, stateEnums.open);
                    break;
                case 'stop':
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.state, stateEnums.stop);
                    break;
                default:
                    throw new Error('TuYa_cover_control: Invalid command received');
                }
            }
        },
    },
    tuya_cover_options: {
        key: ['options'],
        convertSet: async (entity, key, value, meta) => {
            if (value.reverse_direction != undefined) {
                if (value.reverse_direction) {
                    meta.logger.info('Motor direction reverse');
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.motorDirection, 1);
                } else {
                    meta.logger.info('Motor direction forward');
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.motorDirection, 0);
                }
            }

            if (value.motor_speed != undefined) {
                if (value.motor_speed < 0 || value.motor_speed > 255) {
                    throw new Error('TuYa_cover_control: Motor speed is out of range');
                }

                meta.logger.info(`Setting motor speed to ${value.motor_speed}`);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.coverSpeed, value.motor_speed);
            }
        },
    },
    diyruz_freepad_on_off_config: {
        key: ['switch_type', 'switch_actions'],
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOffSwitchCfg', ['switchType', 'switchActions']);
        },
        convertSet: async (entity, key, value, meta) => {
            const switchTypesLookup = {
                toggle: 0x00,
                momentary: 0x01,
                multifunction: 0x02,
            };
            const switchActionsLookup = {
                on: 0x00,
                off: 0x01,
                toggle: 0x02,
            };
            const intVal = parseInt(value, 10);
            const switchType = switchTypesLookup.hasOwnProperty(value) ? switchTypesLookup[value] : intVal;
            const switchActions = switchActionsLookup.hasOwnProperty(value) ? switchActionsLookup[value] : intVal;

            const payloads = {
                switch_type: {switchType},
                switch_actions: {switchActions},
            };
            await entity.write('genOnOffSwitchCfg', payloads[key]);

            return {state: {[`${key}`]: value}};
        },
    },
    TYZB01_on_off: {
        key: ['state', 'time_in_seconds'],
        convertSet: async (entity, key, value, meta) => {
            const result = await converters.on_off.convertSet(entity, key, value, meta);
            const lowerCaseValue = value.toLowerCase();
            if (!['on', 'off'].includes(lowerCaseValue)) {
                return result;
            }
            const messageKeys = Object.keys(meta.message);
            const timeInSecondsValue = function() {
                if (messageKeys.includes('state')) {
                    return meta.message.time_in_seconds;
                }
                if (meta.endpoint_name) {
                    return meta.message[`time_in_seconds_${meta.endpoint_name}`];
                }
                return null;
            }();
            if (!timeInSecondsValue) {
                return result;
            }
            const timeInSeconds = Number(timeInSecondsValue);
            if (!Number.isInteger(timeInSeconds) || timeInSeconds < 0 || timeInSeconds > 0xfffe) {
                throw Error('The time_in_seconds value must be convertible to an integer in the ' +
                    'range: <0x0000, 0xFFFE>');
            }
            const on = lowerCaseValue === 'on';
            await entity.command(
                'genOnOff',
                'onWithTimedOff',
                {
                    ctrlbits: 0,
                    ontime: (on ? 0 : timeInSeconds.valueOf()),
                    offwaittime: (on ? timeInSeconds.valueOf() : 0),
                },
                utils.getOptions(meta.mapped, entity));
            return result;
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['onOff']);
        },
    },
    diyruz_geiger_config: {
        key: ['sensitivity', 'led_feedback', 'buzzer_feedback', 'sensors_count', 'sensors_type', 'alert_threshold'],
        convertSet: async (entity, key, rawValue, meta) => {
            const lookup = {
                'OFF': 0x00,
                'ON': 0x01,
            };
            const sensorsTypeLookup = {
                'СБМ-20/СТС-5/BOI-33': '0',
                'СБМ-19/СТС-6': '1',
                'Others': '2',
            };

            let value = lookup.hasOwnProperty(rawValue) ? lookup[rawValue] : parseInt(rawValue, 10);

            if (key == 'sensors_type') {
                value = sensorsTypeLookup.hasOwnProperty(rawValue) ? sensorsTypeLookup[rawValue] : parseInt(rawValue, 10);
            }

            const payloads = {
                sensitivity: {0xF000: {value, type: 0x21}},
                led_feedback: {0xF001: {value, type: 0x10}},
                buzzer_feedback: {0xF002: {value, type: 0x10}},
                sensors_count: {0xF003: {value, type: 0x20}},
                sensors_type: {0xF004: {value, type: 0x30}},
                alert_threshold: {0xF005: {value, type: 0x23}},
            };

            await entity.write('msIlluminanceLevelSensing', payloads[key]);
            return {
                state: {[key]: rawValue},
            };
        },
        convertGet: async (entity, key, meta) => {
            const payloads = {
                sensitivity: ['msIlluminanceLevelSensing', 0xF000],
                led_feedback: ['msIlluminanceLevelSensing', 0xF001],
                buzzer_feedback: ['msIlluminanceLevelSensing', 0xF002],
                sensors_count: ['msIlluminanceLevelSensing', 0xF003],
                sensors_type: ['msIlluminanceLevelSensing', 0xF004],
                alert_threshold: ['msIlluminanceLevelSensing', 0xF005],
            };
            await entity.read(payloads[key][0], [payloads[key][1]]);
        },
    },
    diyruz_airsense_config: {
        key: ['led_feedback', 'enable_abc', 'threshold1', 'threshold2', 'temperature_offset', 'pressure_offset', 'humidity_offset'],
        convertSet: async (entity, key, rawValue, meta) => {
            const lookup = {'OFF': 0x00, 'ON': 0x01};
            const value = lookup.hasOwnProperty(rawValue) ? lookup[rawValue] : parseInt(rawValue, 10);
            const payloads = {
                led_feedback: ['msCO2', {0x0203: {value, type: 0x10}}],
                enable_abc: ['msCO2', {0x0202: {value, type: 0x10}}],
                threshold1: ['msCO2', {0x0204: {value, type: 0x21}}],
                threshold2: ['msCO2', {0x0205: {value, type: 0x21}}],
                temperature_offset: ['msTemperatureMeasurement', {0x0210: {value, type: 0x29}}],
                pressure_offset: ['msPressureMeasurement', {0x0210: {value, type: 0x2b}}],
                humidity_offset: ['msRelativeHumidity', {0x0210: {value, type: 0x29}}],
            };
            await entity.write(payloads[key][0], payloads[key][1]);
            return {
                state: {[key]: rawValue},
            };
        },
        convertGet: async (entity, key, meta) => {
            const payloads = {
                led_feedback: ['msCO2', 0x0203],
                enable_abc: ['msCO2', 0x0202],
                threshold1: ['msCO2', 0x0204],
                threshold2: ['msCO2', 0x0205],
                temperature_offset: ['msTemperatureMeasurement', 0x0210],
                pressure_offset: ['msPressureMeasurement', 0x0210],
                humidity_offset: ['msRelativeHumidity', 0x0210],
            };
            await entity.read(payloads[key][0], [payloads[key][1]]);
        },
    },
    diyruz_zintercom_config: {
        key: ['mode', 'sound', 'time_ring', 'time_talk', 'time_open', 'time_bell', 'time_report'],
        convertSet: async (entity, key, rawValue, meta) => {
            const lookup = {'OFF': 0x00, 'ON': 0x01};
            const modeOpenLookup = {'never': '0', 'once': '1', 'always': '2', 'drop': '3'};
            let value = lookup.hasOwnProperty(rawValue) ? lookup[rawValue] : parseInt(rawValue, 10);
            if (key == 'mode') {
                value = modeOpenLookup.hasOwnProperty(rawValue) ? modeOpenLookup[rawValue] : parseInt(rawValue, 10);
            }
            const payloads = {
                mode: {0x0051: {value, type: 0x30}},
                sound: {0x0052: {value, type: 0x10}},
                time_ring: {0x0053: {value, type: 0x20}},
                time_talk: {0x0054: {value, type: 0x20}},
                time_open: {0x0055: {value, type: 0x20}},
                time_bell: {0x0057: {value, type: 0x20}},
                time_report: {0x0056: {value, type: 0x20}},
            };
            await entity.write('closuresDoorLock', payloads[key]);
            return {
                state: {[key]: rawValue},
            };
        },
        convertGet: async (entity, key, meta) => {
            const payloads = {
                mode: ['closuresDoorLock', 0x0051],
                sound: ['closuresDoorLock', 0x0052],
                time_ring: ['closuresDoorLock', 0x0053],
                time_talk: ['closuresDoorLock', 0x0054],
                time_open: ['closuresDoorLock', 0x0055],
                time_bell: ['closuresDoorLock', 0x0057],
                time_report: ['closuresDoorLock', 0x0056],
            };
            await entity.read(payloads[key][0], [payloads[key][1]]);
        },
    },
    neo_t_h_alarm: {
        key: [
            'alarm', 'melody', 'volume', 'duration',
            'temperature_max', 'temperature_min', 'humidity_min', 'humidity_max',
            'temperature_alarm', 'humidity_alarm',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'alarm':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.neoAlarm, value);
                break;
            case 'melody':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.neoMelody, parseInt(value, 10));
                break;
            case 'volume':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.neoVolume,
                    {'low': 2, 'medium': 1, 'high': 0}[value]);
                break;
            case 'duration':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.neoDuration, value);
                break;
            case 'temperature_max':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.neoMaxTemp, value);
                break;
            case 'temperature_min':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.neoMinTemp, value);
                break;
            case 'humidity_max':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.neoMaxHumidity, value);
                break;
            case 'humidity_min':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.neoMinHumidity, value);
                break;
            case 'temperature_alarm':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.neoTempAlarm, value);
                break;
            case 'humidity_alarm':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.neoHumidityAlarm, value);
                break;
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
    },
    neo_alarm: {
        key: [
            'alarm', 'melody', 'volume', 'duration',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'alarm':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.neoAOAlarm, value);
                break;
            case 'melody':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.neoAOMelody, parseInt(value, 10));
                break;
            case 'volume':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.neoAOVolume,
                    {'low': 0, 'medium': 1, 'high': 2}[value]);
                break;
            case 'duration':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.neoAODuration, value);
                break;
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
    },
    nous_lcd_temperature_humidity_sensor: {
        key: ['min_temperature', 'max_temperature', 'temperature_sensitivity', 'temperature_unit_convert'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'temperature_unit_convert':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.nousTempUnitConvert, ['°C', '°F'].indexOf(value));
                break;
            case 'min_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.nousMinTemp, Math.round(value * 10));
                break;
            case 'max_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.nousMaxTemp, Math.round(value * 10));
                break;
            case 'temperature_sensitivity':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.nousTempSensitivity, Math.round(value * 10));
                break;
            default: // Unknown key
                meta.logger.warn(`Unhandled key ${key}`);
            }
        },
    },
    ts0201_temperature_humidity_alarm: {
        key: ['alarm_humidity_max', 'alarm_humidity_min', 'alarm_temperature_max', 'alarm_temperature_min'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'alarm_temperature_max':
            case 'alarm_temperature_min':
            case 'alarm_humidity_max':
            case 'alarm_humidity_min': {
                // await entity.write('manuSpecificTuya_2', {[key]: value});
                // instead write as custom attribute to override incorrect herdsman dataType from uint16 to int16
                // https://github.com/Koenkk/zigbee-herdsman/blob/v0.13.191/src/zcl/definition/cluster.ts#L4235
                const keyToAttributeLookup = {'alarm_temperature_max': 0xD00A, 'alarm_temperature_min': 0xD00B,
                    'alarm_humidity_max': 0xD00D, 'alarm_humidity_min': 0xD00E};
                const payload = {[keyToAttributeLookup[key]]: {value: value, type: 0x29}};
                await entity.write('manuSpecificTuya_2', payload);
                break;
            }
            default: // Unknown key
                meta.logger.warn(`Unhandled key ${key}`);
            }
        },
    },
    heiman_ir_remote: {
        key: ['send_key', 'create', 'learn', 'delete', 'get_list'],
        convertSet: async (entity, key, value, meta) => {
            const options = {
                // Don't send a manufacturerCode (otherwise set in herdsman):
                // https://github.com/Koenkk/zigbee-herdsman-converters/pull/2827
                manufacturerCode: null,
                ...utils.getOptions(meta.mapped, entity),
            };
            switch (key) {
            case 'send_key':
                await entity.command('heimanSpecificInfraRedRemote', 'sendKey',
                    {id: value['id'], keyCode: value['key_code']}, options);
                break;
            case 'create':
                await entity.command('heimanSpecificInfraRedRemote', 'createId', {modelType: value['model_type']}, options);
                break;
            case 'learn':
                await entity.command('heimanSpecificInfraRedRemote', 'studyKey',
                    {id: value['id'], keyCode: value['key_code']}, options);
                break;
            case 'delete':
                await entity.command('heimanSpecificInfraRedRemote', 'deleteKey',
                    {id: value['id'], keyCode: value['key_code']}, options);
                break;
            case 'get_list':
                await entity.command('heimanSpecificInfraRedRemote', 'getIdAndKeyCodeList', {}, options);
                break;
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
    },
    scene_store: {
        key: ['scene_store'],
        convertSet: async (entity, key, value, meta) => {
            const isGroup = entity.constructor.name === 'Group';
            const groupid = isGroup ? entity.groupID : value.hasOwnProperty('group_id') ? value.group_id : 0;
            let sceneid = value;
            let scenename = null;
            if (typeof value === 'object') {
                sceneid = value.ID;
                scenename = value.name;
            }

            const response = await entity.command('genScenes', 'store', {groupid, sceneid}, utils.getOptions(meta.mapped));

            if (isGroup) {
                if (meta.membersState) {
                    for (const member of entity.members) {
                        utils.saveSceneState(member, sceneid, groupid, meta.membersState[member.getDevice().ieeeAddr], scenename);
                    }
                }
            } else if (response.status === 0) {
                utils.saveSceneState(entity, sceneid, groupid, meta.state, scenename);
            } else {
                throw new Error(`Scene add not succesfull ('${herdsman.Zcl.Status[response.status]}')`);
            }
            meta.logger.info('Successfully stored scene');
            return {state: {}};
        },
    },
    scene_recall: {
        key: ['scene_recall'],
        convertSet: async (entity, key, value, meta) => {
            const groupid = entity.constructor.name === 'Group' ? entity.groupID : 0;
            const sceneid = value;
            await entity.command('genScenes', 'recall', {groupid, sceneid}, utils.getOptions(meta.mapped));

            const addColorMode = (newState) => {
                if (newState.hasOwnProperty('color_temp')) {
                    newState.color_mode = constants.colorMode[2];
                } else if (newState.hasOwnProperty('color')) {
                    if (newState.color.hasOwnProperty('x')) {
                        newState.color_mode = constants.colorMode[1];
                    } else {
                        newState.color_mode = constants.colorMode[0];
                    }
                }

                return newState;
            };

            const isGroup = entity.constructor.name === 'Group';
            if (isGroup) {
                const membersState = {};
                for (const member of entity.members) {
                    let recalledState = utils.getSceneState(member, sceneid, groupid);
                    if (recalledState) {
                        // add color_mode if saved state does not contain it
                        if (!recalledState.hasOwnProperty('color_mode')) {
                            recalledState = addColorMode(recalledState);
                        }

                        Object.assign(recalledState, libColor.syncColorState(recalledState, meta.state, entity, meta.options, meta.logger));
                        membersState[member.getDevice().ieeeAddr] = recalledState;
                    } else {
                        meta.logger.warn(`Unknown scene was recalled for ${member.getDevice().ieeeAddr}, can't restore state.`);
                        membersState[member.getDevice().ieeeAddr] = {};
                    }
                }
                meta.logger.info('Successfully recalled group scene');
                return {membersState};
            } else {
                let recalledState = utils.getSceneState(entity, sceneid, groupid);
                if (recalledState) {
                    // add color_mode if saved state does not contain it
                    if (!recalledState.hasOwnProperty('color_mode')) {
                        recalledState = addColorMode(recalledState);
                    }

                    Object.assign(recalledState, libColor.syncColorState(recalledState, meta.state, entity, meta.options, meta.logger));
                    meta.logger.info('Successfully recalled scene');
                    return {state: recalledState};
                } else {
                    meta.logger.warn(`Unknown scene was recalled for ${entity.deviceIeeeAddress}, can't restore state.`);
                    return {state: {}};
                }
            }
        },
    },
    scene_add: {
        key: ['scene_add'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== 'object') {
                throw new Error('Payload should be object.');
            }

            if (!value.hasOwnProperty('ID')) {
                throw new Error('Payload missing ID.');
            }

            if (value.hasOwnProperty('color_temp') && value.hasOwnProperty('color')) {
                throw new Error(`Don't specify both 'color_temp' and 'color'`);
            }

            const isGroup = entity.constructor.name === 'Group';
            const groupid = isGroup ? entity.groupID : value.hasOwnProperty('group_id') ? value.group_id : 0;
            const sceneid = value.ID;
            const scenename = value.name;
            const transtime = value.hasOwnProperty('transition') ? value.transition : 0;

            const state = {};
            const extensionfieldsets = [];
            for (let [attribute, val] of Object.entries(value)) {
                if (attribute === 'state') {
                    extensionfieldsets.push({'clstId': 6, 'len': 1, 'extField': [val.toLowerCase() === 'on' ? 1 : 0]});
                    state['state'] = val.toUpperCase();
                } else if (attribute === 'brightness') {
                    extensionfieldsets.push({'clstId': 8, 'len': 1, 'extField': [val]});
                    state['brightness'] = val;
                } else if (attribute === 'color_temp') {
                    /*
                     * ZCL version 7 added support for ColorTemperatureMireds
                     *
                     * Currently no devices seem to support this, so always fallback to XY conversion. In the future if a device
                     * supports this, or other features get added this the following commit contains an implementation:
                     * https://github.com/Koenkk/zigbee-herdsman-converters/pull/1837/commits/c22175b946b83230ce4e711c2a3796cf2029e78f
                     *
                     * Conversion to XY is allowed according to the ZCL:
                     * `Since there is a direct relation between ColorTemperatureMireds and XY,
                     *  color temperature, if supported, is stored as XY in the scenes table.`
                     *
                     * See https://github.com/Koenkk/zigbee2mqtt/issues/4926#issuecomment-735947705
                     */
                    const [colorTempMin, colorTempMax] = light.findColorTempRange(entity, meta.logger);
                    val = light.clampColorTemp(val, colorTempMin, colorTempMax, meta.logger);

                    const xy = libColor.ColorXY.fromMireds(val);
                    const xScaled = utils.mapNumberRange(xy.x, 0, 1, 0, 65535);
                    const yScaled = utils.mapNumberRange(xy.y, 0, 1, 0, 65535);
                    extensionfieldsets.push({'clstId': 768, 'len': 4, 'extField': [xScaled, yScaled]});
                    state['color_mode'] = constants.colorMode[2];
                    state['color_temp'] = val;
                } else if (attribute === 'color') {
                    try {
                        val = JSON.parse(val);
                    } catch (e) {
                        e;
                    }

                    const newColor = libColor.Color.fromConverterArg(val);
                    if (newColor.isXY()) {
                        const xScaled = utils.mapNumberRange(newColor.xy.x, 0, 1, 0, 65535);
                        const yScaled = utils.mapNumberRange(newColor.xy.y, 0, 1, 0, 65535);
                        extensionfieldsets.push(
                            {
                                'clstId': 768,
                                'len': 4,
                                'extField': [xScaled, yScaled],
                            },
                        );
                        state['color_mode'] = constants.colorMode[1];
                        state['color'] = newColor.xy.toObject();
                    } else if (newColor.isHSV()) {
                        const hsvCorrected = newColor.hsv.colorCorrected(meta);
                        if (utils.getMetaValue(entity, meta.mapped, 'enhancedHue', 'allEqual', true)) {
                            const hScaled = utils.mapNumberRange(hsvCorrected.hue, 0, 360, 0, 65535);
                            const sScaled = utils.mapNumberRange(hsvCorrected.saturation, 0, 100, 0, 254);
                            extensionfieldsets.push(
                                {
                                    'clstId': 768,
                                    'len': 13,
                                    'extField': [0, 0, hScaled, sScaled, 0, 0, 0, 0],
                                },
                            );
                        } else {
                            // The extensionFieldSet is always EnhancedCurrentHue according to ZCL
                            // When the bulb or all bulbs in a group do not support enhanchedHue,
                            const colorXY = hsvCorrected.toXY();
                            const xScaled = utils.mapNumberRange(colorXY.x, 0, 1, 0, 65535);
                            const yScaled = utils.mapNumberRange(colorXY.y, 0, 1, 0, 65535);
                            extensionfieldsets.push(
                                {
                                    'clstId': 768,
                                    'len': 4,
                                    'extField': [xScaled, yScaled],
                                },
                            );
                        }
                        state['color_mode'] = constants.colorMode[0];
                        state['color'] = newColor.hsv.toObject(false, false);
                    }
                }
            }

            /*
             * Remove scene first
             *
             * Multiple add scene calls will result in the current and previous
             * payloads to be merged. Resulting in unexpected behavior when
             * trying to replace a scene.
             *
             * We accept a SUCESS or NOT_FOUND as a result of the remove call.
             */
            const removeresp = await entity.command(
                'genScenes', 'remove', {groupid, sceneid}, utils.getOptions(meta.mapped),
            );

            if (isGroup || (removeresp.status === 0 || removeresp.status == 133 || removeresp.status == 139)) {
                const response = await entity.command(
                    'genScenes', 'add', {groupid, sceneid, scenename: '', transtime, extensionfieldsets}, utils.getOptions(meta.mapped),
                );

                if (isGroup) {
                    if (meta.membersState) {
                        for (const member of entity.members) {
                            utils.saveSceneState(member, sceneid, groupid, state, scenename);
                        }
                    }
                } else if (response.status === 0) {
                    utils.saveSceneState(entity, sceneid, groupid, state, scenename);
                } else {
                    throw new Error(`Scene add not succesfull ('${herdsman.Zcl.Status[response.status]}')`);
                }
            } else {
                throw new Error(`Scene add unable to remove existing scene ('${herdsman.Zcl.Status[removeresp.status]}')`);
            }
            meta.logger.info('Successfully added scene');
            return {state: {}};
        },
    },
    scene_remove: {
        key: ['scene_remove'],
        convertSet: async (entity, key, value, meta) => {
            const groupid = entity.constructor.name === 'Group' ? entity.groupID : 0;
            const sceneid = value;
            const response = await entity.command(
                'genScenes', 'remove', {groupid, sceneid}, utils.getOptions(meta.mapped),
            );
            const isGroup = entity.constructor.name === 'Group';
            if (isGroup) {
                if (meta.membersState) {
                    for (const member of entity.members) {
                        utils.deleteSceneState(member, sceneid, groupid);
                    }
                }
            } else if (response.status === 0) {
                utils.deleteSceneState(entity, sceneid, groupid);
            } else {
                throw new Error(`Scene remove not succesfull ('${herdsman.Zcl.Status[response.status]}')`);
            }
            meta.logger.info('Successfully removed scene');
        },
    },
    scene_remove_all: {
        key: ['scene_remove_all'],
        convertSet: async (entity, key, value, meta) => {
            const groupid = entity.constructor.name === 'Group' ? entity.groupID : 0;
            const response = await entity.command(
                'genScenes', 'removeAll', {groupid}, utils.getOptions(meta.mapped),
            );
            const isGroup = entity.constructor.name === 'Group';
            if (isGroup) {
                if (meta.membersState) {
                    for (const member of entity.members) {
                        utils.deleteSceneState(member);
                    }
                }
            } else if (response.status === 0) {
                utils.deleteSceneState(entity);
            } else {
                throw new Error(`Scene remove all not succesfull ('${herdsman.Zcl.Status[response.status]}')`);
            }
            meta.logger.info('Successfully removed all scenes');
        },
    },
    TS0003_curtain_switch: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'close': 1, 'stop': 2, 'open': 1};
            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));
            const endpointID = lookup[value];
            const endpoint = entity.getDevice().getEndpoint(endpointID);
            await endpoint.command('genOnOff', 'on', {}, utils.getOptions(meta.mapped, entity));
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['onOff']);
        },
    },
    saswell_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value * 10);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.saswellHeatingSetpoint, temp);
        },
    },
    saswell_thermostat_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            const schedule = (value === 'auto');
            const enable = !(value === 'off');
            await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellState, enable);
            // Older versions of Saswell TRVs need the delay to work reliably
            await utils.sleep(3000);
            await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellScheduleEnable, schedule);
        },
    },
    saswell_thermostat_away: {
        key: ['away_mode'],
        convertSet: async (entity, key, value, meta) => {
            if (value == 'ON') {
                await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellAwayMode, true);
            } else {
                await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellAwayMode, false);
            }
        },
    },
    saswell_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            // It seems that currently child lock can be sent and device responds,
            // but it's not entering lock state
            await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellChildLock, value === 'LOCK');
        },
    },
    saswell_thermostat_window_detection: {
        key: ['window_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellWindowDetection, value === 'ON');
        },
    },
    saswell_thermostat_frost_detection: {
        key: ['frost_detection'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellFrostDetection, value === 'ON');
        },
    },
    saswell_thermostat_anti_scaling: {
        key: ['anti_scaling'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.saswellAntiScaling, value === 'ON');
        },
    },
    saswell_thermostat_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: async (entity, key, value, meta) => {
            if (value < 0) value = 0xFFFFFFFF + value + 1;
            await tuya.sendDataPointValue(entity, tuya.dataPoints.saswellTempCalibration, value);
        },
    },
    evanell_thermostat_current_heating_setpoint: {
        key: ['current_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const temp = Math.round(value * 10);
            await tuya.sendDataPointValue(entity, tuya.dataPoints.evanellHeatingSetpoint, temp);
        },
    },
    evanell_thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            switch (value) {
            case 'off':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.evanellMode, 3 /* off */);
                break;
            case 'heat':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.evanellMode, 2 /* manual */);
                break;
            case 'auto':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.evanellMode, 0 /* auto */);
                break;
            }
        },
    },
    evanell_thermostat_child_lock: {
        key: ['child_lock'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.evanellChildLock, value === 'LOCK');
        },
    },
    silvercrest_smart_led_string: {
        key: ['color', 'brightness', 'effect'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'effect') {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.silvercrestChangeMode, tuya.silvercrestModes.effect);

                let data = [];
                const effect = tuya.silvercrestEffects[value.effect];
                data = data.concat(tuya.convertStringToHexArray(effect));
                let speed = utils.mapNumberRange(value.speed, 0, 100, 0, 64);

                // Max speed what the gateways sends is 64.
                if (speed > 64) {
                    speed = 64;
                }

                // Make it a string and attach a leading zero (0x30)
                let speedString = String(speed);
                if (speedString.length === 1) {
                    speedString = '0' + speedString;
                }
                if (!speedString) {
                    speedString = '00';
                }

                data = data.concat(tuya.convertStringToHexArray(speedString));
                let colors = value.colors;
                if (!colors && meta.state && meta.state.effect && meta.state.effect.colors) {
                    colors = meta.state.effect.colors;
                }

                if (colors) {
                    for (const color of colors) {
                        let r = '00';
                        let g = '00';
                        let b = '00';

                        if (color.r) {
                            r = color.r.toString(16);
                        }
                        if (r.length === 1) {
                            r = '0' + r;
                        }

                        if (color.g) {
                            g = color.g.toString(16);
                        }
                        if (g.length === 1) {
                            g = '0' + g;
                        }

                        if (color.b) {
                            b = color.b.toString(16);
                        }
                        if (b.length === 1) {
                            b = '0' + b;
                        }

                        data = data.concat(tuya.convertStringToHexArray(r));
                        data = data.concat(tuya.convertStringToHexArray(g));
                        data = data.concat(tuya.convertStringToHexArray(b));
                    }
                }

                await tuya.sendDataPointStringBuffer(entity, tuya.dataPoints.silvercrestSetEffect, data);
            } else if (key === 'brightness') {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.silvercrestChangeMode, tuya.silvercrestModes.white);
                // It expects 2 leading zero's.
                let data = [0x00, 0x00];

                // Scale it to what the device expects (0-1000 instead of 0-255)
                const scaled = utils.mapNumberRange(value, 0, 255, 0, 1000);
                data = data.concat(tuya.convertDecimalValueTo2ByteHexArray(scaled));

                await tuya.sendDataPoint(
                    entity,
                    {dp: tuya.dataPoints.silvercrestSetBrightness, datatype: tuya.dataTypes.value, data: data},
                );
            } else if (key === 'color') {
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.silvercrestChangeMode, tuya.silvercrestModes.color);

                const make4sizedString = (v) => {
                    if (v.length >= 4) {
                        return v;
                    } else if (v.length === 3) {
                        return '0' + v;
                    } else if (v.length === 2) {
                        return '00' + v;
                    } else if (v.length === 1) {
                        return '000' + v;
                    } else {
                        return '0000';
                    }
                };

                const fillInHSB = (h, s, b, state) => {
                    // Define default values. Device expects leading zero in string.
                    const hsb = {
                        h: '0168', // 360
                        s: '03e8', // 1000
                        b: '03e8', // 1000
                    };

                    if (h) {
                        // The device expects 0-359
                        if (h >= 360) {
                            h = 359;
                        }
                        hsb.h = make4sizedString(h.toString(16));
                    } else if (state.color && state.color.h) {
                        hsb.h = make4sizedString(state.color.h.toString(16));
                    }

                    // Device expects 0-1000, saturation normally is 0-100 so we expect that from the user
                    // The device expects a round number, otherwise everything breaks
                    if (s) {
                        hsb.s = make4sizedString(utils.mapNumberRange(s, 0, 100, 0, 1000).toString(16));
                    } else if (state.color && state.color.s) {
                        hsb.s = make4sizedString(utils.mapNumberRange(state.color.s, 0, 100, 0, 1000).toString(16));
                    }

                    // Scale 0-255 to 0-1000 what the device expects.
                    if (b) {
                        hsb.b = make4sizedString(utils.mapNumberRange(b, 0, 255, 0, 1000).toString(16));
                    } else if (state.brightness) {
                        hsb.b = make4sizedString(utils.mapNumberRange(state.brightness, 0, 255, 0, 1000).toString(16));
                    }

                    return hsb;
                };

                let hsb = {};

                if (value.hasOwnProperty('hsb')) {
                    const splitted = value.hsb.split(',').map((i) => parseInt(i));
                    hsb = fillInHSB(splitted[0], splitted[1], splitted[2], meta.state);
                } else {
                    hsb = fillInHSB(
                        value.h || value.hue || null,
                        value.s || value.saturation || null,
                        value.b || value.brightness || null,
                        meta.state);
                }

                let data = [];
                data = data.concat(tuya.convertStringToHexArray(hsb.h));
                data = data.concat(tuya.convertStringToHexArray(hsb.s));
                data = data.concat(tuya.convertStringToHexArray(hsb.b));

                await tuya.sendDataPointStringBuffer(entity, tuya.dataPoints.silvercrestSetColor, data);
            }
        },
    },
    tuya_data_point_test: {
        key: ['tuya_data_point_test'],
        convertSet: async (entity, key, value, meta) => {
            const args = value.split(',');
            const mode = args[0];
            const dp = parseInt(args[1]);
            const data = [];

            switch (mode) {
            case 'raw':
                for (let i = 2; i < args.length; i++) {
                    data.push(parseInt(args[i]));
                }
                await tuya.sendDataPointRaw(entity, dp, data);
                break;
            case 'bool':
                await tuya.sendDataPointBool(entity, dp, args[2] === '1');
                break;
            case 'value':
                await tuya.sendDataPointValue(entity, dp, parseInt(args[2]));
                break;
            case 'enum':
                await tuya.sendDataPointEnum(entity, dp, parseInt(args[2]));
                break;
            case 'bitmap':
                for (let i = 2; i < args.length; i++) {
                    data.push(parseInt(args[i]));
                }
                await tuya.sendDataPointBitmap(entity, dp, data);
                break;
            }
        },
    },
    ts0216_duration: {
        key: ['duration'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('ssIasWd', {'maxDuration': value});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('ssIasWd', ['maxDuration']);
        },
    },
    ts0216_volume: {
        key: ['volume'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('ssIasWd', {0x0002: {value: utils.mapNumberRange(value, 0, 100, 100, 10), type: 0x20}});
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('ssIasWd', [0x0002]);
        },
    },
    ts0216_alarm: {
        key: ['alarm'],
        convertSet: async (entity, key, value, meta) => {
            const info = (value) ? (2 << 4) + (1 << 2) + 0 : 0;

            await entity.command(
                'ssIasWd',
                'startWarning',
                {startwarninginfo: info, warningduration: 0, strobedutycycle: 0, strobelevel: 3},
                utils.getOptions(meta.mapped, entity),
            );
        },
    },
    tuya_cover_calibration: {
        key: ['calibration'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'ON': 0, 'OFF': 1};
            value = value.toUpperCase();
            utils.validateValue(value, Object.keys(lookup));
            const calibration = lookup[value];
            await entity.write('closuresWindowCovering', {tuyaCalibration: calibration});
            return {state: {calibration: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresWindowCovering', ['tuyaCalibration']);
        },
    },
    tuya_cover_reversal: {
        key: ['motor_reversal'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'ON': 1, 'OFF': 0};
            value = value.toUpperCase();
            utils.validateValue(value, Object.keys(lookup));
            const reversal = lookup[value];
            await entity.write('closuresWindowCovering', {tuyaMotorReversal: reversal});
            return {state: {motor_reversal: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresWindowCovering', ['tuyaMotorReversal']);
        },
    },
    moes_cover_calibration: {
        key: ['calibration_time'],
        convertSet: async (entity, key, value, meta) => {
            const calibration = value *10;
            await entity.write('closuresWindowCovering', {moesCalibrationTime: calibration});
            return {state: {calibration_time: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresWindowCovering', ['moesCalibrationTime']);
        },
    },
    tuya_backlight_mode: {
        key: ['backlight_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'LOW': 0, 'MEDIUM': 1, 'HIGH': 2};
            value = value.toUpperCase();
            utils.validateValue(value, Object.keys(lookup));
            const backlight = lookup[value];
            await entity.write('genOnOff', {tuyaBacklightMode: backlight});
            return {state: {backlight_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['tuyaBacklightMode']);
        },
    },
    hy_thermostat: {
        key: [
            'child_lock', 'current_heating_setpoint', 'local_temperature_calibration',
            'max_temperature_protection', 'min_temperature_protection', 'state',
            'hysteresis', 'hysteresis_for_protection',
            'max_temperature_for_protection', 'min_temperature_for_protection',
            'max_temperature', 'min_temperature',
            'sensor_type', 'power_on_behavior', 'week', 'system_mode',
            'away_preset_days', 'away_preset_temperature',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'max_temperature_protection':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.hyMaxTempProtection, value === 'ON');
                break;
            case 'min_temperature_protection':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.hyMinTempProtection, value === 'ON');
                break;
            case 'state':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.hyState, value === 'ON');
                break;
            case 'child_lock':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.hyChildLock, value === 'LOCK');
                break;
            case 'away_preset_days':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyAwayDays, value);
                break;
            case 'away_preset_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyAwayTemp, value);
                break;
            case 'local_temperature_calibration':
                value = Math.round(value * 10);
                if (value < 0) value = 0xFFFFFFFF + value + 1;
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyTempCalibration, value);
                break;
            case 'hysteresis':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyHysteresis, value);
                break;
            case 'hysteresis_for_protection':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyProtectionHysteresis, value);
                break;
            case 'max_temperature_for_protection':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyProtectionMaxTemp, value);
                break;
            case 'min_temperature_for_protection':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyProtectionMinTemp, value);
                break;
            case 'max_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyMaxTemp, value);
                break;
            case 'min_temperature':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyMinTemp, value);
                break;
            case 'current_heating_setpoint':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hyHeatingSetpoint, value);
                break;
            case 'sensor_type':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.hySensor,
                    {'internal': 0, 'external': 1, 'both': 2}[value]);
                break;
            case 'power_on_behavior':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.hyPowerOnBehavior,
                    {'restore': 0, 'off': 1, 'on': 2}[value]);
                break;
            case 'week':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.hyWeekFormat,
                    utils.getKey(tuya.thermostatWeekFormat, value, value, Number));
                break;
            case 'system_mode':
                await tuya.sendDataPointEnum(
                    entity,
                    tuya.dataPoints.hyMode,
                    {'manual': 0, 'auto': 1, 'away': 2}[value]);
                break;
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
    },
    ZB003X: {
        key: [
            'reporting_time', 'temperature_calibration', 'humidity_calibration',
            'illuminance_calibration', 'pir_enable', 'led_enable',
            'reporting_enable', 'sensitivity', 'keep_time',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'reporting_time':
                await tuya.sendDataPointValue(entity, 102, value, 'sendData');
                break;
            case 'temperature_calibration':
                value = Math.round(value * 10);
                if (value < 0) value = 0xFFFFFFFF + value + 1;
                await tuya.sendDataPointValue(entity, 104, value, 'sendData');
                break;
            case 'humidity_calibration':
                if (value < 0) value = 0xFFFFFFFF + value + 1;
                await tuya.sendDataPointValue(entity, 105, value, 'sendData');
                break;
            case 'illuminance_calibration':
                if (value < 0) value = 0xFFFFFFFF + value + 1;
                await tuya.sendDataPointValue(entity, 106, value, 'sendData');
                break;
            case 'pir_enable':
                await tuya.sendDataPointBool(entity, 109, value, 'sendData');
                break;
            case 'led_enable':
                await tuya.sendDataPointBool(entity, 111, value, 'sendData');
                break;
            case 'reporting_enable':
                await tuya.sendDataPointBool(entity, 112, value, 'sendData');
                break;
            case 'sensitivity':
                await entity.write('ssIasZone', {currentZoneSensitivityLevel: {'low': 0, 'medium': 1, 'high': 2}[value]});
                break;
            case 'keep_time':
                await entity.write('ssIasZone', {61441: {value: {'0': 0, '30': 1, '60': 2, '120': 3, '240': 4}[value], type: 0x20}});
                break;
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
    },
    ZM35HQ_attr: {
        key: [
            'sensitivity', 'keep_time',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'sensitivity':
                await entity.write('ssIasZone', {currentZoneSensitivityLevel: {'low': 0, 'medium': 1, 'high': 2}[value]},
                    {sendWhen: 'active'});
                break;
            case 'keep_time':
                await entity.write('ssIasZone', {61441: {value: {'30': 0, '60': 1, '120': 2}[value], type: 0x20}}, {sendWhen: 'active'});
                break;
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
        convertGet: async (entity, key, meta) => {
            // Apparently, reading values may interfere with a commandStatusChangeNotification for changed occupancy.
            // Therefore, read "zoneStatus" as well.
            await entity.read('ssIasZone', ['currentZoneSensitivityLevel', 61441, 'zoneStatus'], {sendWhen: 'active'});
        },
    },
    TS0210_sensitivity: {
        key: ['sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            const sens = {'high': 0, 'medium': 2, 'low': 6}[value];
            await entity.write('ssIasZone', {currentZoneSensitivityLevel: sens});
            return {state: {sensitivity: value}};
        },
    },
    viessmann_window_open: {
        key: ['window_open'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['viessmannWindowOpenInternal'], manufacturerOptions.viessmann);
        },
    },
    viessmann_window_open_force: {
        key: ['window_open_force'],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value === 'boolean') {
                await entity.write('hvacThermostat', {'viessmannWindowOpenForce': value}, manufacturerOptions.viessmann);
                return {readAfterWriteTime: 200, state: {'window_open_force': value}};
            } else {
                meta.logger.error('window_open_force must be a boolean!');
            }
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['viessmannWindowOpenForce'], manufacturerOptions.viessmann);
        },
    },
    viessmann_assembly_mode: {
        key: ['assembly_mode'],
        convertGet: async (entity, key, meta) => {
            await entity.read('hvacThermostat', ['viessmannAssemblyMode'], manufacturerOptions.viessmann);
        },
    },
    dawondns_only_off: {
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            value = value.toLowerCase();
            utils.validateValue(value, ['off']);
            await entity.command('genOnOff', value, {}, utils.getOptions(meta.mapped, entity));
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('genOnOff', ['onOff']);
        },
    },
    idlock_master_pin_mode: {
        key: ['master_pin_mode'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('closuresDoorLock', {0x4000: {value: value === true ? 1 : 0, type: 0x10}},
                {manufacturerCode: 4919});
            return {state: {master_pin_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', [0x4000], {manufacturerCode: 4919});
        },
    },
    idlock_rfid_enable: {
        key: ['rfid_enable'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('closuresDoorLock', {0x4001: {value: value === true ? 1 : 0, type: 0x10}},
                {manufacturerCode: 4919});
            return {state: {rfid_enable: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', [0x4001], {manufacturerCode: 4919});
        },
    },
    idlock_service_mode: {
        key: ['service_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'deactivated': 0, 'random_pin_1x_use': 5, 'random_pin_24_hours': 6};
            await entity.write('closuresDoorLock', {0x4003: {value: lookup[value], type: 0x20}},
                {manufacturerCode: 4919});
            return {state: {service_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', [0x4003], {manufacturerCode: 4919});
        },
    },
    idlock_lock_mode: {
        key: ['lock_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'auto_off_away_off': 0, 'auto_on_away_off': 1, 'auto_off_away_on': 2, 'auto_on_away_on': 3};
            await entity.write('closuresDoorLock', {0x4004: {value: lookup[value], type: 0x20}},
                {manufacturerCode: 4919});
            return {state: {lock_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', [0x4004], {manufacturerCode: 4919});
        },
    },
    idlock_relock_enabled: {
        key: ['relock_enabled'],
        convertSet: async (entity, key, value, meta) => {
            await entity.write('closuresDoorLock', {0x4005: {value: value === true ? 1 : 0, type: 0x10}},
                {manufacturerCode: 4919});
            return {state: {relock_enabled: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('closuresDoorLock', [0x4005], {manufacturerCode: 4919});
        },
    },
    schneider_pilot_mode: {
        key: ['schneider_pilot_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'contactor': 1, 'pilot': 3};
            value = value.toLowerCase();
            utils.validateValue(value, Object.keys(lookup));
            const mode = lookup[value];
            await entity.write('schneiderSpecificPilotMode', {'pilotMode': mode}, {manufacturerCode: 0x105e});
            return {state: {schneider_pilot_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('schneiderSpecificPilotMode', ['pilotMode'], {manufacturerCode: 0x105e});
        },
    },
    schneider_dimmer_mode: {
        key: ['dimmer_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'RC': 1, 'RL': 2};
            utils.validateValue(value, Object.keys(lookup));
            const mode = lookup[value];
            await entity.write('lightingBallastCfg', {0xe000: {value: mode, type: 0x30}}, {manufacturerCode: 0x105e});
            return {state: {dimmer_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingBallastCfg', [0xe000], {manufacturerCode: 0x105e});
        },
    },
    schneider_temperature_measured_value: {
        key: ['temperature_measured_value'],
        convertSet: async (entity, key, value, meta) => {
            await entity.report('msTemperatureMeasurement', {'measuredValue': Math.round(value * 100)});
        },
    },
    schneider_thermostat_system_mode: {
        key: ['system_mode'],
        convertSet: async (entity, key, value, meta) => {
            const systemMode = utils.getKey(constants.thermostatSystemModes, value, undefined, Number);
            entity.saveClusterAttributeKeyValue('hvacThermostat', {systemMode: systemMode});
            return {state: {system_mode: value}};
        },
    },
    schneider_thermostat_occupied_heating_setpoint: {
        key: ['occupied_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const occupiedHeatingSetpoint = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            entity.saveClusterAttributeKeyValue('hvacThermostat', {occupiedHeatingSetpoint: occupiedHeatingSetpoint});
            return {state: {occupied_heating_setpoint: value}};
        },
    },
    schneider_thermostat_control_sequence_of_operation: {
        key: ['control_sequence_of_operation'],
        convertSet: async (entity, key, value, meta) => {
            const val = utils.getKey(constants.thermostatControlSequenceOfOperations, value, value, Number);
            entity.saveClusterAttributeKeyValue('hvacThermostat', {ctrlSeqeOfOper: val});
            return {state: {control_sequence_of_operation: value}};
        },
    },
    schneider_thermostat_pi_heating_demand: {
        key: ['pi_heating_demand'],
        convertSet: async (entity, key, value, meta) => {
            entity.saveClusterAttributeKeyValue('hvacThermostat', {pIHeatingDemand: value});
            return {state: {pi_heating_demand: value}};
        },
    },
    schneider_thermostat_keypad_lockout: {
        key: ['keypad_lockout'],
        convertSet: async (entity, key, value, meta) => {
            const keypadLockout = utils.getKey(constants.keypadLockoutMode, value, value, Number);
            entity.write('hvacUserInterfaceCfg', {keypadLockout}, {sendWhen: 'active'});
            entity.saveClusterAttributeKeyValue('hvacUserInterfaceCfg', {keypadLockout});
            return {state: {keypad_lockout: value}};
        },
    },
    ZNCJMB14LM: {
        key: ['theme',
            'standby_enabled',
            'beep_volume',
            'lcd_brightness',
            'language',
            'screen_saver_style',
            'standby_time',
            'font_size',
            'lcd_auto_brightness_enabled',
            'homepage',
            'screen_saver_enabled',
            'standby_lcd_brightness',
            'available_switches',
            'switch_1_text_icon',
            'switch_2_text_icon',
            'switch_3_text_icon',
        ],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'theme') {
                const lookup = {'classic': 0, 'concise': 1};
                await entity.write('aqaraOpple', {0x0215: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {theme: value}};
            } else if (key === 'standby_enabled') {
                await entity.write('aqaraOpple', {0x0213: {value: value, type: 0x10}}, manufacturerOptions.xiaomi);
                return {state: {standby_enabled: value}};
            } else if (key === 'beep_volume') {
                const lookup = {'mute': 0, 'low': 1, 'medium': 2, 'high': 3};
                await entity.write('aqaraOpple', {0x0212: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {beep_volume: value}};
            } else if (key === 'lcd_brightness') {
                await entity.write('aqaraOpple', {0x0211: {value: value, type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {lcd_brightness: value}};
            } else if (key === 'language') {
                const lookup = {'chinese': 0, 'english': 1};
                await entity.write('aqaraOpple', {0x0210: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {language: value}};
            } else if (key === 'screen_saver_style') {
                const lookup = {'classic': 1, 'analog clock': 2};
                await entity.write('aqaraOpple', {0x0214: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {screen_saver_style: value}};
            } else if (key === 'standby_time') {
                await entity.write('aqaraOpple', {0x0216: {value: value, type: 0x23}}, manufacturerOptions.xiaomi);
                return {state: {standby_time: value}};
            } else if (key === 'font_size') {
                const lookup = {'small': 3, 'medium': 4, 'large': 5};
                await entity.write('aqaraOpple', {0x0217: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {font_size: value}};
            } else if (key === 'lcd_auto_brightness_enabled') {
                await entity.write('aqaraOpple', {0x0218: {value: value, type: 0x10}}, manufacturerOptions.xiaomi);
                return {state: {lcd_auto_brightness_enabled: value}};
            } else if (key === 'homepage') {
                const lookup = {'scene': 0, 'feel': 1, 'thermostat': 2, 'switch': 3};
                await entity.write('aqaraOpple', {0x0219: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {homepage: value}};
            } else if (key === 'screen_saver_enabled') {
                await entity.write('aqaraOpple', {0x0221: {value: value, type: 0x10}}, manufacturerOptions.xiaomi);
                return {state: {screen_saver_enabled: value}};
            } else if (key === 'standby_lcd_brightness') {
                await entity.write('aqaraOpple', {0x0222: {value: value, type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {standby_lcd_brightness: value}};
            } else if (key === 'available_switches') {
                const lookup = {'none': 0, '1': 1, '2': 2, '1 and 2': 3, '3': 4, '1 and 3': 5, '2 and 3': 6, 'all': 7};
                await entity.write('aqaraOpple', {0x022b: {value: lookup[value], type: 0x20}}, manufacturerOptions.xiaomi);
                return {state: {available_switches: value}};
            } else if (key === 'switch_1_text_icon') {
                const lookup = {'1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, '11': 11};
                const payload = [];
                const statearr = {};
                if (value.hasOwnProperty('switch_1_icon')) {
                    payload.push(lookup[value.switch_1_icon]);
                    statearr.switch_1_icon = value.switch_1_icon;
                } else {
                    payload.push(1);
                    statearr.switch_1_icon = '1';
                }
                if (value.hasOwnProperty('switch_1_text')) {
                    payload.push(...value.switch_1_text.split('').map((c) => c.charCodeAt(0)));
                    statearr.switch_1_text = value.switch_1_text;
                } else {
                    payload.push(...''.text.split('').map((c) => c.charCodeAt(0)));
                    statearr.switch_1_text = '';
                }
                await entity.write('aqaraOpple', {0x0223: {value: payload, type: 0x41}}, manufacturerOptions.xiaomi);
                return {state: statearr};
            } else if (key === 'switch_2_text_icon') {
                const lookup = {'1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, '11': 11};
                const payload = [];
                const statearr = {};
                if (value.hasOwnProperty('switch_2_icon')) {
                    payload.push(lookup[value.switch_2_icon]);
                    statearr.switch_2_icon = value.switch_2_icon;
                } else {
                    payload.push(1);
                    statearr.switch_2_icon = '1';
                }
                if (value.hasOwnProperty('switch_2_text')) {
                    payload.push(...value.switch_2_text.split('').map((c) => c.charCodeAt(0)));
                    statearr.switch_2_text = value.switch_2_text;
                } else {
                    payload.push(...''.text.split('').map((c) => c.charCodeAt(0)));
                    statearr.switch_2_text = '';
                }
                await entity.write('aqaraOpple', {0x0224: {value: payload, type: 0x41}}, manufacturerOptions.xiaomi);
                return {state: statearr};
            } else if (key === 'switch_3_text_icon') {
                const lookup = {'1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, '11': 11};
                const payload = [];
                const statearr = {};
                if (value.hasOwnProperty('switch_3_icon')) {
                    payload.push(lookup[value.switch_3_icon]);
                    statearr.switch_3_icon = value.switch_3_icon;
                } else {
                    payload.push(1);
                    statearr.switch_3_icon = '1';
                }
                if (value.hasOwnProperty('switch_3_text')) {
                    payload.push(...value.switch_3_text.split('').map((c) => c.charCodeAt(0)));
                    statearr.switch_3_text = value.switch_3_text;
                } else {
                    payload.push(...''.text.split('').map((c) => c.charCodeAt(0)));
                    statearr.switch_3_text = '';
                }
                await entity.write('aqaraOpple', {0x0225: {value: payload, type: 0x41}}, manufacturerOptions.xiaomi);
                return {state: statearr};
            } else {
                throw new Error(`Not supported: '${key}'`);
            }
        },
    },
    wiser_vact_calibrate_valve: {
        key: ['calibrate_valve'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command('hvacThermostat', 'wiserSmartCalibrateValve', {},
                {srcEndpoint: 11, disableDefaultResponse: true, sendWhen: 'active'});
            return {state: {'calibrate_valve': value}};
        },
    },
    wiser_sed_zone_mode: {
        key: ['zone_mode'],
        convertSet: async (entity, key, value, meta) => {
            return {state: {'zone_mode': value}};
        },
    },
    wiser_sed_occupied_heating_setpoint: {
        key: ['occupied_heating_setpoint'],
        convertSet: async (entity, key, value, meta) => {
            const occupiedHeatingSetpoint = (Math.round((value * 2).toFixed(1)) / 2).toFixed(1) * 100;
            entity.saveClusterAttributeKeyValue('hvacThermostat', {occupiedHeatingSetpoint});
            return {state: {'occupied_heating_setpoint': value}};
        },
    },
    wiser_sed_thermostat_local_temperature_calibration: {
        key: ['local_temperature_calibration'],
        convertSet: (entity, key, value, meta) => {
            entity.write('hvacThermostat', {localTemperatureCalibration: Math.round(value * 10)},
                {srcEndpoint: 11, disableDefaultResponse: true, sendWhen: 'active'});
            return {state: {local_temperature_calibration: value}};
        },
    },
    wiser_sed_thermostat_keypad_lockout: {
        key: ['keypad_lockout'],
        convertSet: async (entity, key, value, meta) => {
            const keypadLockout = utils.getKey(constants.keypadLockoutMode, value, value, Number);
            await entity.write('hvacUserInterfaceCfg', {keypadLockout},
                {srcEndpoint: 11, disableDefaultResponse: true, sendWhen: 'active'});
            return {state: {keypad_lockout: value}};
        },
    },
    moes_105_dimmer: {
        key: ['state', 'brightness'],
        convertSet: async (entity, key, value, meta) => {
            meta.logger.debug(`to moes_105_dimmer key=[${key}], value=[${value}]`);

            const multiEndpoint = utils.getMetaValue(entity, meta.mapped, 'multiEndpoint', 'allEqual', false);
            const lookupState = {l1: tuya.dataPoints.moes105DimmerState1, l2: tuya.dataPoints.moes105DimmerState2};
            const lookupBrightness = {l1: tuya.dataPoints.moes105DimmerLevel1, l2: tuya.dataPoints.moes105DimmerLevel2};
            const stateKeyId = multiEndpoint ? lookupState[meta.endpoint_name] : lookupState.l1;
            const brightnessKeyId = multiEndpoint ? lookupBrightness[meta.endpoint_name] : lookupBrightness.l1;

            switch (key) {
            case 'state':
                await tuya.sendDataPointBool(entity, stateKeyId, value === 'ON', 'dataRequest', 1);
                break;

            case 'brightness':
                if (value >= 0 && value <= 254) {
                    const newValue = utils.mapNumberRange(value, 0, 254, 0, 1000);
                    if (newValue === 0) {
                        await tuya.sendDataPointBool(entity, stateKeyId, false, 'dataRequest', 1);
                    } else {
                        await tuya.sendDataPointBool(entity, stateKeyId, true, 'dataRequest', 1);
                    }
                    await tuya.sendDataPointValue(entity, brightnessKeyId, newValue, 'dataRequest', 1);
                    break;
                } else {
                    throw new Error('Dimmer brightness is out of range 0..254');
                }

            default:
                throw new Error(`Unsupported Key=[${key}]`);
            }
        },
    },
    tuya_do_not_disturb: {
        key: ['do_not_disturb'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command('lightingColorCtrl', 'tuyaDoNotDisturb', {enable: value ? 1 : 0});
            return {state: {do_not_disturb: value}};
        },
    },
    tuya_color_power_on_behavior: {
        key: ['color_power_on_behavior'],
        convertSet: async (entity, key, value, meta) => {
            const lookup = {'initial': 0, 'previous': 1, 'cutomized': 2};
            utils.validateValue(value, Object.keys(lookup));
            await entity.command('lightingColorCtrl', 'tuyaOnStartUp', {
                mode: lookup[value]*256, data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]});
            return {state: {color_power_on_behavior: value}};
        },
    },
    tuya_motion_sensor: {
        key: ['o_sensitivity', 'v_sensitivity', 'led_status', 'vacancy_delay',
            'light_on_luminance_prefer', 'light_off_luminance_prefer', 'mode'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'o_sensitivity':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.msOSensitivity, utils.getKey(tuya.msLookups.OSensitivity, value));
                break;
            case 'v_sensitivity':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.msVSensitivity, utils.getKey(tuya.msLookups.VSensitivity, value));
                break;
            case 'led_status':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.msLedStatus, {'on': 0, 'off': 1}[value.toLowerCase()]);
                break;
            case 'vacancy_delay':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.msVacancyDelay, value);
                break;
            case 'light_on_luminance_prefer':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.msLightOnLuminancePrefer, value);
                break;
            case 'light_off_luminance_prefer':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.msLightOffLuminancePrefer, value);
                break;
            case 'mode':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.msMode, utils.getKey(tuya.msLookups.Mode, value));
                break;
            default: // Unknown key
                meta.logger.warn(`toZigbee.tuya_motion_sensor: Unhandled key ${key}`);
            }
        },
    },
    tuya_radar_sensor: {
        key: ['radar_scene', 'radar_sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'radar_scene':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.trsScene, utils.getKey(tuya.tuyaRadar.radarScene, value));
                break;
            case 'radar_sensitivity':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.trsSensitivity, value);
                break;
            default: // Unknown Key
                meta.logger.warn(`toZigbee.tuya_radar_sensor: Unhandled Key ${key}`);
            }
        },
    },
    tuya_radar_sensor_fall: {
        key: ['radar_scene', 'radar_sensitivity', 'tumble_alarm_time', 'tumble_switch', 'fall_sensitivity'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'radar_scene':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.trsfScene, utils.getKey(tuya.tuyaRadar.radarScene, value));
                break;
            case 'radar_sensitivity':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.trsfSensitivity, value);
                break;
            case 'tumble_switch':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.trsfTumbleSwitch, {'on': true, 'off': false}[value.toLowerCase()]);
                break;
            case 'tumble_alarm_time':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.trsfTumbleAlarmTime, value-1);
                break;
            case 'fall_sensitivity':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.trsfFallSensitivity, value);
                break;
            default: // Unknown Key
                meta.logger.warn(`toZigbee.tuya_radar_sensor_fall: Unhandled Key ${key}`);
            }
        },
    },
    javis_microwave_sensor: {
        key: [
            'illuminance_calibration', 'led_enable',
            'sensitivity', 'keep_time',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'illuminance_calibration':// (10--100) sensor illuminance sensitivity
                if (meta.device.manufacturerName === '_TZE200_kagkgk0i') {
                    await tuya.sendDataPointRaw(entity, 102, [value]);
                    break;
                } else {
                    tuya.sendDataPointRaw(entity, 105, [value]);
                    break;
                }
            case 'led_enable':// OK (value true/false or 1/0)
                if (meta.device.manufacturerName === '_TZE200_kagkgk0i') {
                    await tuya.sendDataPointRaw(entity, 107, [value ? 1 : 0]);
                    break;
                } else {
                    await tuya.sendDataPointRaw(entity, 103, [value ? 1 : 0]);
                    break;
                }

            case 'sensitivity':// value: 25, 50, 75, 100
                await tuya.sendDataPointRaw(entity, 2, [value]);
                break;
            case 'keep_time': // value 0 --> 7 corresponding 5s, 30s, 1, 3, 5, 10, 20, 30 min
                if (meta.device.manufacturerName === '_TZE200_kagkgk0i') {
                    await tuya.sendDataPointRaw(entity, 106, [value]);
                    break;
                } else {
                    await tuya.sendDataPointRaw(entity, 102, [value]);
                    break;
                }
            default: // Unknown key
                throw new Error(`Unhandled key ${key}`);
            }
        },
    },
    moes_thermostat_tv: {
        key: [
            'system_mode', 'window_detection', 'frost_detection', 'child_lock',
            'current_heating_setpoint', 'local_temperature_calibration',
            'holiday_temperature', 'comfort_temperature', 'eco_temperature',
            'open_window_temperature', 'heating_stop', 'preset',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'system_mode':
                if (value != 'off') {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 0);
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, utils.getKey(tuya.tvThermostatMode, value));
                } else {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 1);
                }
                break;
            case 'window_detection':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.tvWindowDetection, value);
                break;
            case 'frost_detection':
                if (value == false) {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvFrostDetection, 0);
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, 1);
                } else {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvFrostDetection, 1);
                }
                break;
            case 'child_lock':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.tvChildLock, value === 'LOCK');
                break;
            case 'local_temperature_calibration':
                value = Math.round(value * 10);
                value = (value < 0) ? 0xFFFFFFFF + value + 1 : value;
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvTempCalibration, value);
                break;
            case 'current_heating_setpoint':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvHeatingSetpoint, value);
                break;
            case 'holiday_temperature':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvHolidayTemp, value);
                break;
            case 'comfort_temperature':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvComfortTemp, value);
                break;
            case 'eco_temperature':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvEcoTemp, value);
                break;
            case 'heating_stop':
                if (value == true) {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 1);
                } else {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 0);
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, 1);
                }
                break;
            // case 'boost_mode':
            //     // set 300sec boost time
            //     await tuya.sendDataPointValue(entity, tuya.dataPoints.tvBoostTime, 300);
            //     await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvBoostMode, (value) ? 0 : 1);
            //     break;
            case 'open_window_temperature':
                value = Math.round(value * 10);
                await tuya.sendDataPointValue(entity, tuya.dataPoints.tvOpenWindowTemp, value);
                break;
            case 'preset':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.tvHeatingStop, 0);
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.tvMode, utils.getKey(tuya.tvThermostatPreset, value));
                break;
            default: // Unknown key
                meta.logger.warn(`toZigbee.moes_thermostat_tv: Unhandled key ${key}`);
            }
        },
    },
    sihas_set_people: {
        key: ['people'],
        convertSet: async (entity, key, value, meta) => {
            const payload = {'presentValue': value};
            const endpoint = meta.device.endpoints.find((e) => e.supportsInputCluster('genAnalogInput'));
            await endpoint.write('genAnalogInput', payload);
        },
        convertGet: async (entity, key, meta) => {
            const endpoint = meta.device.endpoints.find((e) => e.supportsInputCluster('genAnalogInput'));
            await endpoint.read('genAnalogInput', ['presentValue']);
        },
    },
    tuya_operation_mode: {
        key: ['operation_mode'],
        convertSet: async (entity, key, value, meta) => {
            // modes:
            // 0 - 'command' mode. keys send commands. useful for group control
            // 1 - 'event' mode. keys send events. useful for handling
            const lookup = {command: 0, event: 1};
            const endpoint = meta.device.getEndpoint(1);
            await endpoint.write('genOnOff', {'tuyaOperationMode': lookup[value.toLowerCase()]});
            return {state: {operation_mode: value.toLowerCase()}};
        },
        convertGet: async (entity, key, meta) => {
            const endpoint = meta.device.getEndpoint(1);
            await endpoint.read('genOnOff', ['tuyaOperationMode']);
        },
    },
    xiaomi_switch_click_mode: {
        key: ['click_mode'],
        convertSet: async (entity, key, value, meta) => {
            const lookupState = {'fast': 0x1, 'multi': 0x02};
            await entity.write('aqaraOpple', {0x0125: {value: lookupState[value], type: 0x20}}, manufacturerOptions.xiaomi);
            return {state: {click_mode: value}};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('aqaraOpple', [0x125], manufacturerOptions.xiaomi);
        },
    },
    tuya_light_wz5: {
        key: ['color', 'color_temp', 'brightness', 'white_brightness'],
        convertSet: async (entity, key, value, meta) => {
            const separateWhite = (meta.mapped.meta && meta.mapped.meta.separateWhite);
            if (key == 'white_brightness' || (!separateWhite && (key == 'brightness'))) {
                // upscale to 1000
                let newValue;
                if (value >= 0 && value <= 255) {
                    newValue = utils.mapNumberRange(value, 0, 255, 0, 1000);
                } else {
                    throw new Error('Dimmer brightness is out of range 0..255');
                }
                await tuya.sendDataPoints(entity, [
                    tuya.dpValueFromEnum(tuya.dataPoints.silvercrestChangeMode, tuya.silvercrestModes.white),
                    tuya.dpValueFromIntValue(tuya.dataPoints.dimmerLevel, newValue),
                ], 'dataRequest');

                return {state: (key == 'white_brightness') ? {white_brightness: value} : {brightness: value}};
            } else if (key == 'color_temp') {
                const [colorTempMin, colorTempMax] = [250, 454];
                const preset = {
                    'warmest': colorTempMax,
                    'warm': 454,
                    'neutral': 370,
                    'cool': 250,
                    'coolest': colorTempMin,
                };
                if (typeof value === 'string' && isNaN(value)) {
                    const presetName = value.toLowerCase();
                    if (presetName in preset) {
                        value = preset[presetName];
                    } else {
                        throw new Error(`Unknown preset '${value}'`);
                    }
                } else {
                    value = light.clampColorTemp(Number(value), colorTempMin, colorTempMax, meta.logger);
                }
                const data = utils.mapNumberRange(value, colorTempMax, colorTempMin, 0, 1000);

                await tuya.sendDataPoints(entity, [
                    tuya.dpValueFromEnum(tuya.dataPoints.silvercrestChangeMode, tuya.silvercrestModes.white),
                    tuya.dpValueFromIntValue(tuya.dataPoints.silvercrestSetColorTemp, data),
                ], 'dataRequest');

                return {state: {color_temp: value}};
            } else if (key == 'color' || (separateWhite && (key == 'brightness'))) {
                const newState = {};
                if (key == 'brightness') {
                    newState.brightness = value;
                } else if (key == 'color') {
                    newState.color = value;
                    newState.color_mode = 'hs';
                }

                const make4sizedString = (v) => {
                    if (v.length >= 4) {
                        return v;
                    } else if (v.length === 3) {
                        return '0' + v;
                    } else if (v.length === 2) {
                        return '00' + v;
                    } else if (v.length === 1) {
                        return '000' + v;
                    } else {
                        return '0000';
                    }
                };

                const fillInHSB = (h, s, b, state) => {
                    // Define default values. Device expects leading zero in string.
                    const hsb = {
                        h: '0168', // 360
                        s: '03e8', // 1000
                        b: '03e8', // 1000
                    };

                    if (h) {
                        // The device expects 0-359
                        if (h >= 360) {
                            h = 359;
                        }
                        hsb.h = make4sizedString(h.toString(16));
                    } else if (state.color && state.color.hue) {
                        hsb.h = make4sizedString(state.color.hue.toString(16));
                    }

                    // Device expects 0-1000, saturation normally is 0-100 so we expect that from the user
                    // The device expects a round number, otherwise everything breaks
                    if (s) {
                        hsb.s = make4sizedString(utils.mapNumberRange(s, 0, 100, 0, 1000).toString(16));
                    } else if (state.color && state.color.saturation) {
                        hsb.s = make4sizedString(utils.mapNumberRange(state.color.saturation, 0, 100, 0, 1000).toString(16));
                    }

                    // Scale 0-255 to 0-1000 what the device expects.
                    if (b != null) {
                        hsb.b = make4sizedString(utils.mapNumberRange(b, 0, 255, 0, 1000).toString(16));
                    } else if (state.brightness != null) {
                        hsb.b = make4sizedString(utils.mapNumberRange(state.brightness, 0, 255, 0, 1000).toString(16));
                    }
                    return hsb;
                };

                const hsb = fillInHSB(
                    value.h || value.hue || null,
                    value.s || value.saturation || null,
                    value.b || value.brightness || (key == 'brightness') ? value : null,
                    meta.state,
                );


                let data = [];
                data = data.concat(tuya.convertStringToHexArray(hsb.h));
                data = data.concat(tuya.convertStringToHexArray(hsb.s));
                data = data.concat(tuya.convertStringToHexArray(hsb.b));

                const commands = [
                    tuya.dpValueFromEnum(tuya.dataPoints.silvercrestChangeMode, tuya.silvercrestModes.color),
                    tuya.dpValueFromStringBuffer(tuya.dataPoints.silvercrestSetColor, data),
                ];

                await tuya.sendDataPoints(entity, commands, 'dataRequest');

                return {state: newState};
            }
        },
    },
    ZMAM02: {
        key: ['control', 'percent_control', 'mode', 'control_back_mode', 'border', 'motor_working_mode'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'control':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.AM02Control, utils.getKey(tuya.ZMAM02.AM02Control, value));
                break;
            case 'percent_control':
                await tuya.sendDataPointValue(entity, tuya.dataPoints.AM02PercentState, value);
                break;
            case 'mode':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.AM02Mode, utils.getKey(tuya.ZMAM02.AM02Mode, value));
                break;
            case 'control_back_mode':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.AM02ControlBackMode, utils.getKey(tuya.ZMAM02.AM02Direction, value));
                break;
            case 'border':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.AM02Border, utils.getKey(tuya.ZMAM02.AM02Border, value));
                break;
            case 'motor_working_mode':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.AM02MotorWorkingMode, utils.getKey(tuya.ZMAM02.AM02MotorMode, value));
                break;
            default: // Unknown Key
                meta.logger.warn(`toZigbee.ZMAM02: Unhandled Key ${key}`);
            }
        },
    },
    // #endregion

    // #region Ignore converters
    ignore_transition: {
        key: ['transition'],
        attr: [],
        convertSet: async (entity, key, value, meta) => {
        },
    },
    ignore_rate: {
        key: ['rate'],
        attr: [],
        convertSet: async (entity, key, value, meta) => {
        },
    },
    // #endregion

    // Not a converter, can be used by tests to clear the store.
    __clearStore__: () => {
        globalStore.clear();
    },
    hoch_din: {
        key: ['state',
            'child_lock',
            'countdown_timer',
            'power_on_behaviour',
            'trip',
            'clear_device_data',
            /* TODO: Add the below keys when toZigbee converter work has been completed
            'voltage_setting',
            'current_setting',
            'temperature_setting',
            'leakage_current_setting'*/
        ],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'state') {
                await tuya.sendDataPointBool(entity, tuya.dataPoints.state, value === 'ON');
                return {state: {state: value}};
            } else if (key === 'child_lock') {
                await tuya.sendDataPointBool(entity, tuya.dataPoints.hochChildLock, value === 'ON');
                return {state: {child_lock: value}};
            } else if (key === 'countdown_timer') {
                await tuya.sendDataPointValue(entity, tuya.dataPoints.hochCountdownTimer, value);
                return {state: {countdown_timer: value}};
            } else if (key === 'power_on_behaviour') {
                const lookup = {'off': 0, 'on': 1, 'previous': 2};
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.hochRelayStatus, lookup[value], 'sendData');
                return {state: {power_on_behaviour: value}};
            } else if (key === 'trip') {
                if (value === 'clear') {
                    await tuya.sendDataPointBool(entity, tuya.dataPoints.hochLocking, true, 'sendData');
                }
                return {state: {trip: 'clear'}};
            } else if (key === 'clear_device_data') {
                await tuya.sendDataPointBool(entity, tuya.dataPoints.hochClearEnergy, true, 'sendData');
            /* TODO: Release the below with other toZigbee converters for device composites
            } else if (key === 'temperature_setting') {
                if (value.over_temperature_threshold && value.over_temperature_trip && value.over_temperature_alarm){
                    const payload = [];
                    payload.push(value.over_temperature_threshold < 1
                        ? ((value.over_temperature_threshold * -1) + 128)
                        : value.over_temperature_threshold);
                    payload.push(value.over_temperature_trip === 'ON' ? 1 : 0);
                    payload.push(value.over_temperature_alarm === 'ON' ? 1 : 0);
                    await tuya.sendDataPointRaw(entity, tuya.dataPoints.hochTemperatureThreshold, payload, 'sendData');
                    return {state: {over_temperature_threshold: value.over_temperature_threshold,
                        over_temperature_trip: value.over_temperature_trip,
                        over_temperature_alarm: value.over_temperature_alarm}};
                }*/
            } else {
                throw new Error(`Not supported: '${key}'`);
            }
        },
    },
};

module.exports = converters;
