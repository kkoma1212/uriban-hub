import { createPool, type PoolConnection } from "mysql2";
import type { MariaDbPoolFactory } from "./connection.js";
import type { MariaDbRawConnection } from "./guarded-driver.js";

/** Product callback adapter; credentials and TLS settings come only from the guarded factory. */
export const createMysql2MariaDbPool: MariaDbPoolFactory = (configuration) => {
  const pool = createPool(configuration);
  const connections = new WeakMap<PoolConnection, MariaDbRawConnection>();
  return {
    on: (event: "error", listener: () => void) => pool.on(event, listener),
    getConnection(callback) {
      pool.getConnection((error, connection) => {
        if (error) {
          callback(error, undefined as never);
          return;
        }
        let wrapped = connections.get(connection);
        if (!wrapped) {
          const physical = connection as PoolConnection & {
            stream?: { encrypted?: unknown; authorized?: unknown };
            config?: { ssl?: { rejectUnauthorized?: unknown; verifyIdentity?: unknown } | string };
          };
          const facade = {
            readRuntimeTls: () => {
              const ssl = physical.config?.ssl;
              return Object.freeze({
                encrypted: physical.stream?.encrypted === true,
                authorized: physical.stream?.authorized === true,
                rejectUnauthorized: typeof ssl === "object" && ssl?.rejectUnauthorized === true,
                verifyIdentity: typeof ssl === "object" && ssl?.verifyIdentity === true,
              });
            },
            query: (
              statement: string,
              parameters: readonly unknown[],
              done: (error: unknown, result: unknown) => void,
            ) => connection.query(statement, [...parameters], done),
            release: () => connection.release(),
            destroy: () => connection.destroy(),
            on: (event: "error", listener: () => void) => connection.on(event, listener),
          };
          wrapped = facade;
          connections.set(connection, wrapped);
        }
        callback(null, wrapped);
      });
    },
    end: (callback) => pool.end(callback),
  };
};
