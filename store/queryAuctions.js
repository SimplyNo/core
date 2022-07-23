/* eslint-disable consistent-return */
/*
* Allows custom DB queries for auctions API endpoint
 */
const cachedFunction = require('./cachedFunction');
const redis = require('./redis');
const { logger, redisBulk } = require('../util/utility');
const {
  min, max, median, average, standardDeviation,
} = require('../util/math');
const parseTimestamp = require('../util/readableTimestamps');

async function queryAuctionId(from, to, showAuctions = false, itemId) {
  const now = Date.now();
  let fromDate = from || (now - 24 * 60 * 60 * 1000);
  let toDate = to || now;

  if (typeof from === 'string') {
    fromDate = parseTimestamp(from);
  }

  if (typeof to === 'string') {
    toDate = parseTimestamp(to);
  }

  if (Number.isNaN(Number(fromDate)) || Number.isNaN(Number(toDate))) {
    throw new TypeError("Parameters 'from' and 'to' must be integers");
  }
  return cachedFunction(`auctions:${itemId}:${from}:${to}`, async () => {
    try {
      const auctions = await redis.zrangebyscore(itemId, fromDate, toDate);
      const result = {
        average_price: 0,
        median_price: 0,
        standard_deviation: 0,
        min_price: 0,
        max_price: 0,
        lowest_bin: 0,
        sold: 0,
        auctions: {},
      };
      const priceArray = [];
      const binArray = [];
      auctions.forEach((auction) => {
        auction = JSON.parse(auction);
        const { bids } = auction;
        if (bids.length > 0) priceArray.push(bids[bids.length - 1].amount / auction.item.count);
        if ('bin' in auction && auction.bin) binArray.push(auction.starting_bid / auction.item.count);
        result.auctions[auction.end] = auction;
      });
      result.average_price = average(priceArray);
      result.median_price = median(priceArray);
      result.standard_deviation = standardDeviation(priceArray);
      result.min_price = min(priceArray);
      result.max_price = max(priceArray);
      result.lowest_bin = min(binArray) || 0;
      result.sold = priceArray.length;
      if (!showAuctions) {
        delete result.auctions;
      }
      return result;
    } catch (error) {
      logger.error(error);
    }
  }, { cacheDuration: 60 });
}

async function getAuctions({
  auctionUUID = null,
  id = null,
  bin = null,
  category = null,
  rarity = null,
  sortBy = 'end',
  sortOrder = 'desc',
  limit = 1000,
  page = 1,
}) {
  const intersection = ['auction_ids'];
  if (auctionUUID) {
    const auction = await redis.hgetall(`auction:${auctionUUID}`);
    return [auction];
  }
  if (bin) {
    intersection.push('auction_bins');
  }
  if (id) {
    intersection.push(`auction_item_id:${id}`);
  }
  const ids = await redis.zinter(intersection.length, intersection);
  let auctions = await redisBulk(redis, 'hgetall', ids, [], 'auction');
  // Remove empty entries and remove error entries
  auctions = auctions.filter(([, a]) => a !== null).map(([, a]) => a);
  // filter
  if (category) {
    auctions = auctions.filter((a) => a.category === category);
  }
  if (rarity) {
    auctions = auctions.filter((a) => a.tier === rarity);
  }
  // sort
  function sort(a, b) {
    if (sortOrder === 'asc') {
      return a[sortBy] - b[sortBy];
    }
    return b[sortBy] - a[sortBy];
  }
  if (!(sortBy in auctions[0])) {
    throw new Error(`Can't sort by ${sortBy}`);
  }
  auctions = auctions.sort(sort);
  // meta
  let meta = await redis.get('auction_meta');
  try {
    meta = JSON.parse(meta);
  } catch (error) {
    logger.warn(`Failed parsing auction meta: ${error}`);
  }
  // pagination
  const pageSize = Math.min(1000, Number.parseInt(limit, 10));
  const result = auctions.slice((page - 1) * pageSize, page * pageSize);
  return {
    last_updated: meta.lastUpdated || null,
    total_auctions: meta.totalAuctions || 0,
    matching_query: auctions.length,
    auctions: result,
  };
}

module.exports = { getAuctions, queryAuctionId };
