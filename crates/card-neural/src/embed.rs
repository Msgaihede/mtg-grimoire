//! The fingerprint: a second small CNN that turns a rectified 128×128 view of the card's top
//! part into a unit-length vector, which [`crate::gallery::Gallery::top`] then searches.
//!
//! **The gallery is not in the network**, as it is in quickdraw.cards' (a `MatMul` and a
//! `TopK` after the embedding): kept apart, it can be rebuilt for a new set without exporting
//! the network again, and searched under the reader's filters.

use crate::meta::EmbedderMeta;
use crate::Error;
use rten::{Model, NodeId};
use rten_tensor::{AsView, Layout, NdTensorView, Tensor};

pub struct Embedder {
    model: Model,
    input: NodeId,
    embedding: NodeId,
    pub meta: EmbedderMeta,
}

impl Embedder {
    pub fn load(bytes: Vec<u8>, meta: EmbedderMeta) -> Result<Self, Error> {
        let model = Model::load(bytes).map_err(|e| Error::Model(format!("embedder: {e}")))?;
        let id = |name: &str| {
            model
                .node_id(name)
                .map_err(|e| Error::Model(format!("embedder {name}: {e}")))
        };
        let input = id("crops")?;
        let embedding = id("embedding")?;
        Ok(Self {
            model,
            input,
            embedding,
            meta,
        })
    }

    /// Embed `n` crops held in `crops` (`n × 3 × h × w`, normalised CHW): `n` unit vectors of
    /// `meta.dim`, one after another.
    pub fn run(&self, crops: &[f32], n: usize) -> Result<Vec<f32>, Error> {
        let (w, h) = (self.meta.width, self.meta.height);
        assert_eq!(crops.len(), n * 3 * w * h, "crop batch is the wrong size");
        let input = NdTensorView::from_data([n, 3, h, w], crops);
        let [embedding] = self
            .model
            .run_n(vec![(self.input, input.into())], [self.embedding], None)
            .map_err(|e| Error::Model(format!("embedder run: {e}")))?;
        let embedding: Tensor<f32> = embedding
            .try_into()
            .map_err(|e| Error::Model(format!("embedding: {e:?}")))?;
        if embedding.shape() != [n, self.meta.dim] {
            return Err(Error::Model(format!(
                "the embedding has shape {:?}, not [{n}, {}]",
                embedding.shape(),
                self.meta.dim
            )));
        }
        Ok(embedding.to_vec())
    }
}
