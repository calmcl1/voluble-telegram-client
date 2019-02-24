import * as ffi from 'ffi-napi'
var winston = require('winston');
import * as path from 'path'
import * as crypto from 'crypto'
import { TdQuery, TdUpdate, TdUpdateAuthorizationState, ITdObject, TdError, TdOk } from './tdApi'

// tdlib JSON documentation here: https://core.telegram.org/tdlib/docs/td__json__client_8h.html
// tdlib API documentation here: https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1_function.html

async function asyncTimeout(timeout = 500) {
    return new Promise((resolve) => {
        setTimeout(resolve, 500)
    })
}

export class TdLibClient {
    PATH_TO_LIBRARY_FILE: string = '/var/libtdjson.so'
    tdlib: any
    private client: any
    private inFlightRequests: { resolve: (resp: TdUpdate | TdOk) => void, reject: (err: any) => void }[] = []

    constructor() {
        this.tdlib = ffi.Library(
            this.PATH_TO_LIBRARY_FILE,
            {
                'td_json_client_create': ['pointer', []],
                'td_json_client_send': ['void', ['pointer', 'string']],
                'td_json_client_receive': ['string', ['pointer', 'double']],
                'td_json_client_execute': ['string', ['pointer', 'string']],
                'td_json_client_destroy': ['void', ['pointer']],
                'td_set_log_file_path': ['int', ['string']],
                'td_set_log_verbosity_level': ['void', ['int']],
                'td_set_log_fatal_error_callback': ['void', ['pointer']]
            }
        )

        // Create client
        this.client = this.tdlib.td_json_client_create()
        this.tdlib.td_set_log_file_path('/var/calmc/Source/Repos/voluble-telegram-client/logs.txt')
        this.tdlib.td_set_log_verbosity_level(4)
        this.init()
    }

    private async init() {
        await asyncTimeout(1000)
        this.doReceiveLoop()
    }

    private buildQuery(query: TdQuery) {
        const buffer = Buffer.from(JSON.stringify(query) + '\0', 'utf-8')
        //buffer.type = ref.types.CString
        return buffer
    }

    private _send(query: TdQuery) {
        try {
            return new Promise((resolve, reject) => {
                this.tdlib.td_json_client_send.async(this.client, this.buildQuery(query), (err: Error, res: any) => {
                    if (err) {
                        winston.error(`Couldn't send query ${query["@type"]}`)
                        reject(err)
                    }
                    else {
                        resolve(res ? res : null)
                    }
                })
            })
                .catch((err) => { winston.error("i love errors") })
        } catch{
            throw new Error("oh noes")
        }
    }

    private async _execute(query: TdQuery) {
        return new Promise((resolve, reject) => {
            this.tdlib.td_json_client_execute.async(this.client, this.buildQuery(query), (err: Error, res: any) => {
                if (err) { reject(err) }
                else {
                    resolve(res ? JSON.parse(res) : null)
                }
            })
        })
    }

    private async _receive(timeout = 2): Promise<TdUpdate | TdOk | null> {
        return new Promise((resolve, reject) => {
            this.tdlib.td_json_client_receive.async(this.client, timeout, (err: Error, res: any) => {
                if (err) {
                    winston.info("Got error, should this be coerced in future?")
                    reject(err)
                }
                else if (!res) {
                    resolve(null)
                } else {
                    let res_parsed = JSON.parse(res)
                    if (res_parsed["@type"] == "error") {
                        reject(<TdError>res_parsed)
                    } else {
                        resolve(<TdUpdate>res_parsed)
                    }
                }
            })
        })
    }

    destroy() {
        this.tdlib.td_json_client_destroy(this.client)
    }

    async sendQuery(query: TdQuery) {
        let query_id = Math.floor(Math.random() * (2 ** 32) - 1)
        query["@extra"] = query_id
        winston.info("Sending req " + query_id + ": " + query["@type"])
        try {
            return this._send(query)
                .then(() => {
                    return new Promise<TdUpdate | TdOk>((resolve, reject) => {
                        this.inFlightRequests[query_id] = { resolve, reject }
                    })
                })
        } catch (err) {
            winston.error("couldn't use sendQuery for " + query["@type"])
        }
    }

    private async handleUpdateAuthorizationState(authState: TdUpdateAuthorizationState) {
        winston.debug(`Received authorization_state: ${authState.authorization_state["@type"]}`)
        switch (authState.authorization_state["@type"]) {
            case "authorizationStateWaitCode":
                break
            case "authorizationStateWaitEncryptionKey":
                winston.debug("Sending checkDatabaseEncryptionKey with default key")
                return await this._send({ "@type": "checkDatabaseEncryptionKey", "encryption_key": "" })
            case "authorizationStateWaitPassword":
                break
            case "authorizationStateWaitPhoneNumber":
                winston.debug("Sending setAuthenticationPhoneNumber")
                return await this._send({
                    "@type": "setAuthenticationPhoneNumber",
                    "phone_number": "+447426437449",
                    "allow_flash_call": false,
                    "is_current_phone_number": true //even though this is ignore
                })
            case "authorizationStateWaitTdlibParameters":
                break
            case "authorizationStateReady":
                winston.debug("Authorized and ready")
                break

        }
    }

    async doReceiveLoop() {
        let update;

        try {
            update = await this._receive()
        } catch (err) {
            winston.error(`Caught error ${err.code}: ${err.message}`)
            if (err["@extra"]) {
                // This error is a response to a manual request, pass it on
                this.inFlightRequests[err["@extra"]].reject(<TdError>err)
                delete this.inFlightRequests[err["@extra"]]
            } else {
                winston.error(`Caught error ${err.code}: ${err.message}`)
            }
        }

        if (update) {
            switch (update["@type"]) {
                case "updateAuthorizationState":
                    this.handleUpdateAuthorizationState(<TdUpdateAuthorizationState>update)
                        .catch((err) => { throw err })
                    break
                case "updateOption":
                    break
                default:
                    break
            }



            if (update["@extra"]) {
                /* This is a response to a request that was sent manually via
                 * sendQuery; there's a promise waiting for it, so just hand it over */
                //winston.debug(`Not directly handling response to query ${update["@extra"]}`)
                winston.debug(`Resolving request ${update["@extra"]} (${update["@type"]})`)
                this.inFlightRequests[update['@extra']].resolve(update)
                delete this.inFlightRequests[update["@extra"]]
            } else {
                /* This is an unsolicited update; Telegram is notifying us of something.
                 * Follow it up. */

                // winston.info("Got unsolicited update")
                // winston.info(update)
            }
        }

        this.doReceiveLoop()

    }
}